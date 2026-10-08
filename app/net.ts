export type NetState = [x: number, z: number, yaw: number, pose: number, seated: number];

export type NetPlayer = {
  id: string;
  name: string;
  look: number[];
  d: NetState;
};

export type NetChat = {
  id: string;
  name: string;
  text: string;
};

type Handlers = {
  onWelcome: (self: string, room: string, players: NetPlayer[]) => void;
  onJoin: (player: NetPlayer) => void;
  onLeave: (id: string) => void;
  onUpdate: (updates: Array<[string, ...NetState]>, count: number) => void;
  onChat: (chat: NetChat) => void;
  onStatus: (status: "connecting" | "online" | "offline") => void;
};

export const PARK_ROOM = "hangout";

const hash = (value: string) => {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};

export function relayUrl(room: string) {
  const configured = (process.env.NEXT_PUBLIC_RELAY_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length > 0) return configured[hash(room || PARK_ROOM) % configured.length];
  const secure = window.location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${window.location.host}/relay`;
}

export function connectRelay(
  room: string,
  name: string,
  look: number[],
  initial: NetState,
  handlers: Handlers,
) {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  let timer = 0;
  let lastSent = "";
  let lastSentAt = 0;
  let lastChatAt = 0;
  let pending: NetState = initial;

  const open = () => {
    if (closed) return;
    handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl(room));
    } catch {
      retry();
      return;
    }
    socket = ws;
    ws.onopen = () => {
      attempt = 0;
      ws.send(JSON.stringify({ t: "join", room, name, look, d: pending }));
      lastSent = JSON.stringify(pending);
    };
    ws.onmessage = (event) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.t === "welcome") {
        handlers.onStatus("online");
        handlers.onWelcome(String(message.id), String(message.room), (message.players as NetPlayer[]) ?? []);
      } else if (message.t === "join") {
        handlers.onJoin(message.p as NetPlayer);
      } else if (message.t === "leave") {
        handlers.onLeave(String(message.id));
      } else if (message.t === "u") {
        handlers.onUpdate((message.u as Array<[string, ...NetState]>) ?? [], Number(message.n ?? 0));
      } else if (message.t === "c") {
        handlers.onChat({
          id: String(message.id ?? ""),
          name: String(message.name ?? "Guest"),
          text: String(message.m ?? ""),
        });
      }
    };
    ws.onclose = () => {
      if (socket === ws) socket = null;
      retry();
    };
    ws.onerror = () => {
      ws.close();
    };
  };

  const retry = () => {
    if (closed) return;
    handlers.onStatus("offline");
    attempt += 1;
    const wait = Math.min(15000, 800 * 2 ** Math.min(attempt, 5));
    window.clearTimeout(timer);
    timer = window.setTimeout(open, wait);
  };

  open();

  return {
    send(state: NetState, now: number) {
      pending = state;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (now - lastSentAt < 95) return;
      const rounded: NetState = [
        Math.round(state[0] * 100) / 100,
        Math.round(state[1] * 100) / 100,
        Math.round(state[2] * 100) / 100,
        state[3],
        state[4],
      ];
      const encoded = JSON.stringify(rounded);
      if (encoded === lastSent) return;
      lastSent = encoded;
      lastSentAt = now;
      socket.send(`{"t":"s","d":${encoded}}`);
    },
    chat(text: string, now: number) {
      const trimmed = text.replace(/\s+/g, " ").trim().slice(0, 120);
      if (!trimmed) return false;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      if (now - lastChatAt < 400) return false;
      lastChatAt = now;
      socket.send(JSON.stringify({ t: "c", m: trimmed }));
      return true;
    },
    close() {
      closed = true;
      window.clearTimeout(timer);
      socket?.close();
      socket = null;
    },
  };
}
