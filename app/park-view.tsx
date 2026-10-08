"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type * as THREE from "three";
import { connectRelay, PARK_ROOM, type NetPlayer, type NetState } from "./net";

type ViewMode = "first" | "third";

type Pose = "idle" | "walk" | "run" | "play";

type Look = {
  skin: number;
  hair: number;
  cloth: number[];
  police: boolean;
};

type Actor = {
  group: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Record<Pose, THREE.AnimationAction>;
  pose: Pose;
  role: "visitor" | "police" | "player";
  lines: string[];
  line: number;
  cooldown: number;
  talking: number;
  bubble: THREE.Sprite | null;
  facing: number;
  seated: boolean;
  voice: number;
  stagger: number;
};

type Collider = {
  x: number;
  z: number;
  r: number;
  hx?: number;
  hz?: number;
  rot?: number;
  owner?: Actor;
  fixed?: boolean;
};

type Walker = Actor & {
  route: Array<{ x: number; z: number }>;
  index: number;
  speed: number;
  pause: number;
  collider: Collider;
  stuck: number;
  side: number;
};

type Rig = {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
};

type Idle = {
  object: THREE.Object3D;
  base: number;
  phase: number;
  sway?: THREE.Object3D;
};

type AudioStatus = "off" | "on" | "muted";

type Scooter = {
  group: THREE.Group;
  rider: Actor;
  collider: Collider;
  route: Array<{ x: number; z: number }>;
  index: number;
  speed: number;
  pause: number;
  stuck: number;
  side: number;
};

type CamMode = "explore" | "combat" | "aim" | "interact" | "cinematic";

type ParkControls = {
  sit: () => void;
  setView: (mode: ViewMode) => void;
  toggleMusic: () => void;
  setStick: (x: number, y: number) => void;
  pokeAudio: () => void;
  setRun: (down: boolean) => void;
  hit: () => void;
  wave: () => void;
  jump: () => void;
  dodge: () => void;
  setAim: (down: boolean) => void;
  setCrouch: (down: boolean) => void;
  chat: (text: string) => boolean;
  useItem: (kind: string) => void;
};

type QuestView = {
  id: string;
  title: string;
  detail: string;
  done: boolean;
};

type BagItem = {
  kind: "gun" | "cream" | "flower" | "shades";
  name: string;
  qty: number;
};

type ChatLine = {
  key: number;
  from: string;
  text: string;
  self?: boolean;
  system?: boolean;
};

type HudBridge = {
  setNotice: (text: string | null) => void;
  setHintHidden: (hidden: boolean) => void;
  setSitting: (sitting: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setAudio: (status: AudioStatus) => void;
  setQuests: (quests: QuestView[]) => void;
  setQuestToast: (title: string) => void;
  setPocket: (pocket: { cash: number; gun: boolean; items: BagItem[] }) => void;
  setOnline: (info: { status: "connecting" | "online" | "offline"; count: number; room: string }) => void;
  setPeople: (people: Array<{ id: string; name: string }>) => void;
  pushChat: (line: Omit<ChatLine, "key">) => void;
  setAiming: (aiming: boolean) => void;
  bind: (controls: ParkControls) => void;
};

type Remote = {
  actor: Actor;
  body: Collider;
  target: { x: number; z: number; yaw: number };
  pose: Pose;
  name: string;
};

type Session = {
  name: string;
  room: string;
};

const QUEST_LIST: Array<Omit<QuestView, "done">> = [
  { id: "gazebo", title: "Find the gazebo", detail: "Walk into the middle of the park." },
  { id: "seat", title: "Take a seat", detail: "Sit on a bench." },
  { id: "pond", title: "See the pond", detail: "Walk over to the pond." },
  { id: "cream", title: "Get a scoop", detail: "Visit the ice cream stand." },
  { id: "rally", title: "Watch a rally", detail: "Stop by the table tennis game." },
  { id: "pool", title: "Check the pool", detail: "Walk to the pool deck." },
  { id: "guard", title: "Meet security", detail: "Stand next to a police officer." },
];

const STASH_KEY = "hangout-stash";
const ITEM_NAME: Record<BagItem["kind"], string> = {
  gun: "Gun",
  cream: "Ice cream",
  flower: "Flower",
  shades: "Shades",
};

function loadStash(): { cash: number; items: BagItem[] } {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STASH_KEY) ?? "");
    const cash = Math.max(0, Math.trunc(Number(parsed?.cash) || 0));
    const items: BagItem[] = [];
    for (const entry of Array.isArray(parsed?.items) ? parsed.items : []) {
      const kind = entry?.kind as BagItem["kind"];
      if (!ITEM_NAME[kind]) continue;
      const qty = Math.max(1, Math.trunc(Number(entry.qty) || 1));
      const existing = items.find((item) => item.kind === kind);
      if (existing) existing.qty += qty;
      else items.push({ kind, name: ITEM_NAME[kind], qty });
    }
    return { cash, items };
  } catch {
    return { cash: 0, items: [] };
  }
}

function saveStash(cash: number, items: BagItem[]) {
  try {
    window.localStorage.setItem(STASH_KEY, JSON.stringify({ cash, items }));
  } catch {
    /* ignore */
  }
}

export default function ParkView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<ParkControls | null>(null);
  const bridgeRef = useRef<HudBridge | null>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const chatKey = useRef(0);
  const [view, setView] = useState<ViewMode>("third");
  const [sitting, setSitting] = useState(false);
  const [audio, setAudio] = useState<AudioStatus>("off");
  const [notice, setNotice] = useState<string | null>(null);
  const [hintHidden, setHintHidden] = useState(false);
  const [ready, setReady] = useState(false);
  const [quests, setQuests] = useState<QuestView[]>(() => QUEST_LIST.map((quest) => ({ ...quest, done: false })));
  const [questsOpen, setQuestsOpen] = useState(false);
  const [questToast, setQuestToast] = useState<string | null>(null);
  const [pocket, setPocket] = useState({ cash: 0, gun: false, items: [] as BagItem[] });
  const [bagOpen, setBagOpen] = useState(false);
  const [online, setOnline] = useState<{ status: "connecting" | "online" | "offline"; count: number; room: string }>({
    status: "connecting",
    count: 1,
    room: "",
  });
  const [people, setPeople] = useState<Array<{ id: string; name: string }>>([]);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [aiming, setAiming] = useState(false);
  const [parkUrl, setParkUrl] = useState("");
  const toastTimer = useRef(0);
  const coarse = useMediaQuery("(pointer: coarse)");
  const narrow = useMediaQuery("(max-width: 639px)");
  const hint = notice ?? (coarse
    ? "Stick moves. Drag looks. Hold Aim for over-the-shoulder. Open Bag for what you own."
    : "Scroll or WASD moves · mouse looks · Space jumps · right mouse aims · E buys a scoop");
  const questsDone = quests.filter((quest) => quest.done).length;

  const pushChat = (line: Omit<ChatLine, "key">) => {
    chatKey.current += 1;
    const next = { ...line, key: chatKey.current };
    setChat((lines) => [...lines.slice(-36), next]);
  };

  bridgeRef.current = {
    setNotice,
    setHintHidden,
    setSitting,
    setViewMode: setView,
    setAudio,
    setQuests,
    setPocket,
    setOnline,
    setPeople,
    pushChat,
    setAiming,
    setQuestToast: (title) => {
      setQuestToast(title);
      window.clearTimeout(toastTimer.current);
      toastTimer.current = window.setTimeout(() => setQuestToast(null), 3200);
    },
    bind: (controls) => {
      controlsRef.current = controls;
      setReady(true);
    },
  };

  useEffect(() => {
    setQuestsOpen(!(coarse || narrow));
    setChatOpen(!(coarse || narrow));
  }, [coarse, narrow]);

  useEffect(() => {
    const node = chatLogRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat]);

  useEffect(() => {
    let name = "";
    try {
      name = window.localStorage.getItem("hangout-name")?.trim().slice(0, 16) ?? "";
    } catch {
      /* ignore */
    }
    if (!name) {
      name = `Guest ${Math.floor(Math.random() * 900) + 100}`;
      try {
        window.localStorage.setItem("hangout-name", name);
      } catch {
        /* ignore */
      }
    }
    setSession({ name, room: PARK_ROOM });
    void fetch("/health")
      .then((response) => response.json())
      .then((info: { public?: string | null; lan?: string | null }) => {
        setParkUrl(info.public || info.lan || window.location.origin);
      })
      .catch(() => {
        setParkUrl(window.location.origin);
      });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code === "KeyQ" && !event.repeat && !isTypingTarget(event.target)) setQuestsOpen((open) => !open);
      if (event.code === "Enter" && !event.repeat && !isTypingTarget(event.target) && session) {
        event.preventDefault();
        setChatOpen(true);
        window.setTimeout(() => chatInputRef.current?.focus(), 0);
      }
      if (event.code === "Escape" && isTypingTarget(event.target)) (event.target as HTMLElement).blur();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(toastTimer.current);
    };
  }, [session]);

  useEffect(() => {
    const host = hostRef.current;
    const bridge = bridgeRef.current;
    if (!host || !bridge || !session) return;

    let cancelled = false;
    let teardown = () => {};

    (async () => {
      const THREE = await import("three");
      if (cancelled || !hostRef.current || !bridgeRef.current || !session) return;
      try {
        teardown = await mountPark(THREE, hostRef.current, bridgeRef.current, session);
        if (cancelled) teardown();
      } catch (error) {
        console.error(error);
        if (hostRef.current) hostRef.current.dataset.parkError = error instanceof Error ? error.message : String(error);
      }
    })();

    return () => {
      cancelled = true;
      teardown();
    };
  }, [session]);

  const sendChat = () => {
    const text = chatDraft.trim();
    if (!text) return;
    const sent = controlsRef.current?.chat(text) ?? false;
    if (sent) setChatDraft("");
  };

  const press = (action: (controls: ParkControls) => void) => {
    const controls = controlsRef.current;
    if (!controls) return;
    action(controls);
  };

  return (
    <>
      <div ref={hostRef} className="absolute inset-0" />
      {!ready && (
        <div className="absolute inset-0 z-20 grid place-items-center bg-[#b7e3f7]">
          <p className="rounded-full bg-white/90 px-5 py-3 text-base font-semibold text-[#1e3328] shadow-sm">
            Opening the park…
          </p>
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 z-10 text-[#1e3328]">
        <div className="pointer-events-auto absolute top-[max(0.75rem,env(safe-area-inset-top))] left-[max(0.75rem,env(safe-area-inset-left))] w-[min(16.5rem,calc(100vw-8.5rem))] sm:w-60">
          <button
            type="button"
            onClick={() => setQuestsOpen((open) => !open)}
            className="min-h-11 rounded-full bg-white/90 px-3.5 text-sm font-semibold shadow-sm"
          >
            Quests {questsDone}/{quests.length}
          </button>
          <div className="mt-2 flex flex-wrap gap-2">
            <p className="w-fit rounded-full bg-white/90 px-3 py-1.5 text-xs font-semibold shadow-sm">
              Cash ${pocket.cash}
            </p>
            <button
              type="button"
              onClick={() => setBagOpen((open) => !open)}
              className="w-fit rounded-full bg-white/90 px-3 py-1.5 text-xs font-semibold shadow-sm"
            >
              Bag {pocket.items.reduce((sum, item) => sum + item.qty, 0)}
            </button>
            <button
              type="button"
              onClick={() => setPeopleOpen((open) => !open)}
              className="w-fit rounded-full bg-white/90 px-3 py-1.5 text-xs font-semibold shadow-sm"
            >
              {online.status === "online"
                ? `${online.count} in the park`
                : online.status === "connecting"
                  ? "Connecting…"
                  : "Offline · solo"}
            </button>
          </div>
          {bagOpen && (
            <ul className="mt-2 space-y-2 rounded-2xl bg-white/92 p-3 text-sm shadow-sm">
              <li className="font-semibold">Yours</li>
              {pocket.items.length === 0 && (
                <li className="text-xs opacity-70">Cash, flowers, shades, and scoops you buy stay in this bag.</li>
              )}
              {pocket.items.map((item) => (
                <li key={item.kind} className="flex items-center justify-between gap-2">
                  <span>
                    {item.name}
                    {item.qty > 1 ? ` ×${item.qty}` : ""}
                  </span>
                  <button
                    type="button"
                    className="text-xs font-semibold"
                    onClick={() => press((controls) => controls.useItem(item.kind))}
                  >
                    Use
                  </button>
                </li>
              ))}
            </ul>
          )}
          {peopleOpen && (
            <ul className="mt-2 space-y-1 rounded-2xl bg-white/92 p-3 text-sm shadow-sm">
              <li className="font-semibold">{session?.name ?? "You"} · you</li>
              {people.map((person) => (
                <li key={person.id}>{person.name}</li>
              ))}
              {people.length === 0 && <li className="text-xs opacity-70">Anyone who opens this site walks in here.</li>}
              {parkUrl && <li className="text-xs break-all opacity-70">{parkUrl}</li>}
            </ul>
          )}
          {questsOpen && (
            <ol className="mt-2 max-h-[min(52vh,24rem)] space-y-2 overflow-y-auto rounded-2xl bg-white/92 p-3 shadow-sm">
              {quests.map((quest) => (
                <li key={quest.id} className={quest.done ? "opacity-55" : ""}>
                  <p className="text-sm leading-snug font-semibold">
                    {quest.done ? "✓ " : ""}
                    {quest.title}
                  </p>
                  {!quest.done && <p className="text-xs leading-snug">{quest.detail}</p>}
                </li>
              ))}
              {questsDone === quests.length && (
                <li className="text-sm font-semibold">You know The Hangout.</li>
              )}
            </ol>
          )}
        </div>
        {aiming && (
          <div className="pointer-events-none absolute top-1/2 left-1/2 z-20 h-4 w-4 -translate-x-1/2 -translate-y-1/2">
            <span className="absolute inset-0 rounded-full border border-[#1e3328]/80" />
            <span className="absolute top-1/2 left-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1e3328]" />
          </div>
        )}
        {questToast && (
          <p className="absolute top-[max(4.5rem,env(safe-area-inset-top))] left-1/2 w-[min(92vw,22rem)] -translate-x-1/2 rounded-full bg-[#1e3328] px-4 py-2 text-center text-sm font-semibold text-[#f7f1e4] shadow-sm">
            Quest complete: {questToast}
          </p>
        )}
        <div className="absolute top-0 right-0 left-[8.75rem] p-3 pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:left-auto">
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:justify-end">
            <HudButton disabled={!ready} active={view === "first"} onClick={() => press((controls) => controls.setView("first"))}>
              <span className="sm:hidden">First</span>
              <span className="hidden sm:inline">First person</span>
            </HudButton>
            <HudButton disabled={!ready} active={view === "third"} onClick={() => press((controls) => controls.setView("third"))}>
              <span className="sm:hidden">Third</span>
              <span className="hidden sm:inline">Third person</span>
            </HudButton>
            <HudButton disabled={!ready} active={audio === "on"} className="hidden sm:inline-flex" onClick={() => press((controls) => controls.toggleMusic())}>
              {audio === "muted" ? "Muted" : "Music"}
            </HudButton>
            <HudButton disabled={!ready} active={sitting} className="hidden sm:inline-flex" onClick={() => press((controls) => controls.sit())}>
              {sitting ? "Stand" : "Sit"}
            </HudButton>
            <HoldButton disabled={!ready} className="hidden sm:inline-flex" onHold={(down) => press((controls) => controls.setRun(down))}>
              Sprint
            </HoldButton>
            <HudButton disabled={!ready} className="hidden sm:inline-flex" onClick={() => press((controls) => controls.jump())}>
              Jump
            </HudButton>
            <HoldButton disabled={!ready} active={aiming} className="hidden sm:inline-flex" onHold={(down) => press((controls) => controls.setAim(down))}>
              Aim
            </HoldButton>
            <HudButton disabled={!ready} className="hidden sm:inline-flex" onClick={() => press((controls) => controls.hit())}>
              Hit
            </HudButton>
            <HudButton disabled={!ready} className="hidden sm:inline-flex" onClick={() => press((controls) => controls.wave())}>
              Wave
            </HudButton>
          </div>
        </div>

        <p
          className={`absolute left-1/2 w-[min(92vw,36rem)] -translate-x-1/2 rounded-2xl bg-white/90 px-3 py-2 text-center text-[13px] leading-snug font-medium shadow-sm transition-opacity sm:rounded-full sm:px-4 sm:text-sm ${coarse ? "bottom-[calc(11.5rem+env(safe-area-inset-bottom))]" : "bottom-[calc(7.25rem+env(safe-area-inset-bottom))] sm:bottom-[5.5rem]"} ${hintHidden && !chatOpen ? "opacity-0" : "opacity-100"}`}
        >
          {hint}
        </p>

        {session && (
          <div
            className={`pointer-events-auto absolute left-[max(0.75rem,env(safe-area-inset-left))] w-[min(22rem,calc(100vw-1.5rem))] ${coarse ? "bottom-[calc(8.6rem+env(safe-area-inset-bottom))]" : "bottom-[max(0.75rem,env(safe-area-inset-bottom))] sm:bottom-3"}`}
          >
            {coarse && (
              <button
                type="button"
                onClick={() => setChatOpen((open) => !open)}
                className="mb-2 min-h-11 rounded-full bg-white/90 px-3.5 text-sm font-semibold shadow-sm"
              >
                Chat{chat.length > 0 ? ` · ${chat[chat.length - 1]?.from}` : ""}
              </button>
            )}
            {chatOpen && (
              <div className="overflow-hidden rounded-2xl bg-white/94 shadow-sm">
                <div ref={chatLogRef} className="max-h-[min(28vh,12rem)] space-y-1 overflow-y-auto px-3 py-2 text-[13px] leading-snug">
                  {chat.length === 0 && (
                    <p className="opacity-60">Say hi. Friends in this park will see it.</p>
                  )}
                  {chat.map((line) => (
                    <p key={line.key} className={line.system ? "opacity-60" : ""}>
                      {line.system ? line.text : (
                        <>
                          <span className="font-semibold">{line.self ? "You" : line.from}</span>
                          {": "}
                          {line.text}
                        </>
                      )}
                    </p>
                  ))}
                </div>
                <form
                  className="flex border-t border-[#1e3328]/10"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendChat();
                  }}
                >
                  <input
                    ref={chatInputRef}
                    value={chatDraft}
                    maxLength={120}
                    enterKeyHint="send"
                    autoComplete="off"
                    placeholder={online.status === "online" ? "Talk in the park…" : "Waiting for the park…"}
                    onChange={(event) => setChatDraft(event.target.value)}
                    className="min-h-11 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none"
                  />
                  <button type="submit" className="px-3 text-sm font-semibold">
                    Send
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        <div className={`absolute inset-x-0 bottom-0 flex items-end gap-3 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] ${coarse ? "" : "sm:hidden"}`}>
          {coarse ? (
            <Joystick
              onUse={() => press((controls) => controls.pokeAudio())}
              onChange={(x, y) => controlsRef.current?.setStick(x, y)}
            />
          ) : (
            <span />
          )}
          <div className="ml-auto grid grid-cols-2 gap-2 sm:hidden">
            <HoldButton disabled={!ready} onHold={(down) => press((controls) => controls.setRun(down))}>
              Sprint
            </HoldButton>
            <HudButton disabled={!ready} onClick={() => press((controls) => controls.jump())}>
              Jump
            </HudButton>
            <HoldButton disabled={!ready} active={aiming} onHold={(down) => press((controls) => controls.setAim(down))}>
              Aim
            </HoldButton>
            <HudButton disabled={!ready} onClick={() => press((controls) => controls.hit())}>
              Hit
            </HudButton>
            <HudButton disabled={!ready} active={sitting} onClick={() => press((controls) => controls.sit())}>
              {sitting ? "Stand" : "Sit"}
            </HudButton>
            <HudButton disabled={!ready} onClick={() => press((controls) => controls.wave())}>
              Wave
            </HudButton>
          </div>
        </div>
      </div>
    </>
  );
}

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function HoldButton({
  active,
  disabled,
  className = "inline-flex",
  onHold,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onHold: (down: boolean) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        onHold(true);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        onHold(false);
      }}
      onPointerCancel={() => onHold(false)}
      onPointerLeave={() => onHold(false)}
      className={`pointer-events-auto min-h-11 items-center justify-center rounded-full px-3.5 text-sm font-semibold shadow-sm select-none disabled:opacity-60 ${active ? "bg-[#1e3328] text-[#f7f1e4]" : "bg-white/90 text-[#1e3328] active:bg-[#1e3328] active:text-[#f7f1e4]"} ${className}`}
    >
      {children}
    </button>
  );
}

function HudButton({
  active,
  disabled,
  className = "inline-flex",
  onClick,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`pointer-events-auto min-h-11 items-center justify-center rounded-full px-3.5 text-sm font-semibold shadow-sm disabled:opacity-60 ${active ? "bg-[#1e3328] text-[#f7f1e4]" : "bg-white/90 text-[#1e3328]"} ${className}`}
    >
      {children}
    </button>
  );
}

function Joystick({ onChange, onUse }: { onChange: (x: number, y: number) => void; onUse: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const active = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onUseRef = useRef(onUse);
  onChangeRef.current = onChange;
  onUseRef.current = onUse;

  useEffect(() => {
    const root = rootRef.current;
    const knob = knobRef.current;
    if (!root || !knob) return;
    const max = 36;
    const place = (x: number, y: number) => {
      knob.style.left = `calc(50% - 1.5rem + ${x}px)`;
      knob.style.top = `calc(50% - 1.5rem + ${y}px)`;
    };
    const end = (event: PointerEvent) => {
      if (event.pointerId !== active.current) return;
      active.current = null;
      onChangeRef.current(0, 0);
      place(0, 0);
    };
    const down = (event: PointerEvent) => {
      event.stopPropagation();
      event.preventDefault();
      onUseRef.current();
      active.current = event.pointerId;
      root.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== active.current) return;
      const rect = root.getBoundingClientRect();
      let x = event.clientX - (rect.left + rect.width / 2);
      let y = event.clientY - (rect.top + rect.height / 2);
      const len = Math.hypot(x, y) || 1;
      const clamped = Math.min(max, len);
      x = (x / len) * clamped;
      y = (y / len) * clamped;
      place(x, y);
      onChangeRef.current(x / max, -y / max);
    };
    root.addEventListener("pointerdown", down);
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    return () => {
      root.removeEventListener("pointerdown", down);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", end);
      root.removeEventListener("pointercancel", end);
      onChangeRef.current(0, 0);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="pointer-events-auto relative h-28 w-28 shrink-0 touch-none rounded-full border-2 border-[#1e3328]/30 bg-white/40"
    >
      <div ref={knobRef} className="absolute top-[calc(50%-1.5rem)] left-[calc(50%-1.5rem)] h-12 w-12 rounded-full bg-[#1e3328]/85" />
    </div>
  );
}

async function mountPark(
  THREE: typeof import("three"),
  host: HTMLDivElement,
  bridge: HudBridge,
  session: Session,
) {
  const [{ GLTFLoader }, { clone }, { MeshoptDecoder }, { RoomEnvironment }] = await Promise.all([
    import("three/examples/jsm/loaders/GLTFLoader.js"),
    import("three/examples/jsm/utils/SkeletonUtils.js"),
    import("three/examples/jsm/libs/meshopt_decoder.module.js"),
    import("three/examples/jsm/environments/RoomEnvironment.js"),
  ]);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [maleGltf, femaleGltf] = await Promise.all([
    loader.loadAsync("/models/chars/m_party.glb"),
    loader.loadAsync("/models/chars/f_party.glb"),
  ]);
  const rigs = { male: maleGltf, female: femaleGltf };
  const characterDisposables = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];
  const idlers: Idle[] = [];

  const geo = <T extends THREE.BufferGeometry>(geometry: T) => {
    geometries.push(geometry);
    return geometry;
  };
  const mat = <T extends THREE.Material>(material: T) => {
    materials.push(material);
    return material;
  };

  const width = host.clientWidth || window.innerWidth;
  const height = host.clientHeight || window.innerHeight;
  const mobile = window.matchMedia("(pointer: coarse)").matches;
  host.style.touchAction = "none";

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xc9e4f4, 36, 88);
  const camera = new THREE.PerspectiveCamera(68, width / height, 0.08, 220);
  camera.rotation.order = "YXZ";

  const renderer = new THREE.WebGLRenderer({
    antialias: !mobile,
    powerPreference: mobile ? "low-power" : "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, mobile ? 1 : 1.5));
  renderer.setSize(width, height);
  renderer.setClearColor(0xc5e4f4);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = !mobile;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.style.touchAction = "none";
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  host.appendChild(renderer.domElement);

  let view: ViewMode = "third";
  let trySit = () => {};
  let tryHit = () => {};
  let tryWave = () => {};
  let tryJump = () => {};
  let tryDodge = () => {};
  let mouseRun = false;
  let buttonRun = false;
  let aiming = false;
  let crouching = false;
  let noticeLeft = 0;
  let combatUntil = 0;
  let cinematic = 0;
  let airY = 0;
  let airV = 0;
  let dodgeLeft = 0;
  let dodgeX = 0;
  let dodgeZ = 0;
  let camDist = 4.2;
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const boomDir = new THREE.Vector3();
  const parkAudio = createParkAudio();
  const syncAudio = () => bridge.setAudio(parkAudio.status());

  if ("speechSynthesis" in window) window.speechSynthesis.getVoices();
  const keys = { forward: false, back: false, left: false, right: false, run: false, crouch: false };
  const padLook = { x: 0, y: 0 };
  const padPrev = { jump: false, dodge: false, sit: false, wave: false, hit: false };
  const stick = { x: 0, y: 0 };
  const motion = { f: 0, s: 0 };
  let wheelMove = 0;
  let yaw = 0;
  let pitch = -0.16;
  let bodyYaw = Math.PI;
  let locked = false;
  let lookId: number | null = null;
  let lookX = 0;
  let lookY = 0;
  const setKey = (code: string, down: boolean) => {
    if (code === "KeyW" || code === "ArrowUp") keys.forward = down;
    if (code === "KeyS" || code === "ArrowDown") keys.back = down;
    if (code === "KeyA" || code === "ArrowLeft") keys.left = down;
    if (code === "KeyD" || code === "ArrowRight") keys.right = down;
    if (code === "ShiftLeft" || code === "ShiftRight") keys.run = down;
    if (code === "ControlLeft" || code === "ControlRight") keys.crouch = down;
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;
    if (event.code === "KeyV" && !event.repeat) setView(view === "first" ? "third" : "first");
    if ((event.code === "KeyC" || event.code === "KeyE") && !event.repeat) trySit();
    if (event.code === "KeyF" && !event.repeat) tryHit();
    if (event.code === "KeyT" && !event.repeat) tryWave();
    if (event.code === "Space" && !event.repeat) {
      event.preventDefault();
      tryJump();
    }
    if (event.code === "KeyZ" && !event.repeat) tryDodge();
    if (event.code === "KeyM" && !event.repeat) {
      parkAudio.toggle();
      syncAudio();
    }
    parkAudio.start();
    syncAudio();
    setKey(event.code, true);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.code)) {
      event.preventDefault();
    }
  };
  const onKeyUp = (event: KeyboardEvent) => setKey(event.code, false);
  const onClick = () => {
    parkAudio.start();
    syncAudio();
    if (mobile) return;
    if (document.pointerLockElement !== renderer.domElement) {
      const lock = renderer.domElement.requestPointerLock();
      if (lock && typeof lock.catch === "function") lock.catch(() => {});
    }
  };
  const onMouseMove = (event: MouseEvent) => {
    if (!locked) return;
    yaw -= event.movementX * (aiming ? 0.0016 : 0.0022);
    pitch = Math.max(-0.72, Math.min(0.62, pitch - event.movementY * (aiming ? 0.0014 : 0.002)));
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    parkAudio.start();
    syncAudio();
    const raw = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    const notch = Math.max(-0.75, Math.min(0.75, -raw / 140));
    wheelMove = Math.max(-1.15, Math.min(1.15, wheelMove + notch));
  };
  const onContextMenu = (event: Event) => event.preventDefault();
  const onRunButton = (event: PointerEvent) => {
    if (event.button !== 2) return;
    aiming = event.type === "pointerdown";
    bridge.setAiming(aiming);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button === 2) {
      event.preventDefault();
      aiming = true;
      bridge.setAiming(true);
      return;
    }
    if (event.pointerType === "mouse") return;
    parkAudio.start();
    syncAudio();
    lookId = event.pointerId;
    lookX = event.clientX;
    lookY = event.clientY;
    try {
      renderer.domElement.setPointerCapture(event.pointerId);
    } catch {
      /* pointer already released */
    }
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== lookId) return;
    const dx = event.clientX - lookX;
    const dy = event.clientY - lookY;
    lookX = event.clientX;
    lookY = event.clientY;
    yaw -= dx * (aiming ? 0.0038 : 0.0055);
    pitch = Math.max(-0.72, Math.min(0.62, pitch - dy * (aiming ? 0.0032 : 0.0045)));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (event.button === 2) {
      aiming = false;
      bridge.setAiming(false);
    }
    if (event.pointerId !== lookId) return;
    lookId = null;
  };
  const onLockChange = () => {
    locked = document.pointerLockElement === renderer.domElement;
    bridge.setHintHidden(locked);
  };
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("pointerdown", onRunButton);
  window.addEventListener("pointerup", onRunButton);
  window.addEventListener("contextmenu", onContextMenu);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("pointerlockchange", onLockChange);
  renderer.domElement.addEventListener("click", onClick);
  renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointermove", onPointerMove);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  renderer.domElement.addEventListener("pointercancel", onPointerUp);

  scene.add(new THREE.HemisphereLight(0xfff4e4, 0x6a9458, 0.72));
  scene.add(new THREE.AmbientLight(0xfff8ef, 0.18));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.45);
  sun.position.set(-18, 28, 12);
  sun.castShadow = !mobile;
  sun.shadow.mapSize.set(mobile ? 512 : 2048, mobile ? 512 : 2048);
  sun.shadow.camera.near = 8;
  sun.shadow.camera.far = 64;
  sun.shadow.camera.left = -22;
  sun.shadow.camera.right = 22;
  sun.shadow.camera.top = 22;
  sun.shadow.camera.bottom = -22;
  sun.shadow.bias = -0.00018;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = mobile ? 1.5 : 3;
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xc5daf0, 0.42);
  fill.position.set(16, 10, -12);
  scene.add(fill);
  let envMap: THREE.Texture | null = null;
  if (!mobile) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    envMap = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envMap;
    scene.environmentIntensity = 0.36;
    pmrem.dispose();
  }

  const grass = mat(
    new THREE.MeshStandardMaterial({
      map: grassTexture(THREE, textures, mobile),
      roughness: 0.96,
    }),
  );
  const earth = mat(new THREE.MeshStandardMaterial({ color: 0xc6a36a }));
  const dirt = mat(new THREE.MeshStandardMaterial({ color: 0x6d9144 }));
  const path = mat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: groundTexture(THREE, textures, "#d9c39a", "#b89a72"),
      roughness: 0.92,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  const stone = mat(
    new THREE.MeshStandardMaterial({
      map: tileTexture(THREE, textures, "#efe8da", "#cfc5b2", 8),
      roughness: 0.82,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    }),
  );
  const wood = mat(new THREE.MeshStandardMaterial({ color: 0xc4844a, roughness: 0.72, envMapIntensity: 0.25 }));
  const woodDark = mat(new THREE.MeshStandardMaterial({ color: 0x8a5a32, roughness: 0.74, envMapIntensity: 0.25 }));
  const metal = mat(new THREE.MeshStandardMaterial({ color: 0x5e6974, roughness: 0.32, metalness: 0.62, envMapIntensity: 0.9 }));
  const water = waterMaterial(THREE, { shallow: "#5aa7c8", deep: "#1d6184", alpha: 0.9 });
  const poolWater = waterMaterial(THREE, { shallow: "#8fe3f0", deep: "#2fa6cc", alpha: 0.58 });
  materials.push(water, poolWater);
  const roof = mat(new THREE.MeshStandardMaterial({ color: 0xc65b45, roughness: 0.72 }));
  const leafMats = ["#3f8f3d", "#2c6b32", "#4e9a48", "#245c34"].map((color) =>
    mat(new THREE.MeshStandardMaterial({ color, roughness: 0.62, envMapIntensity: 0.35 })),
  );
  const trunk = mat(new THREE.MeshStandardMaterial({ color: 0x6e4a2c, roughness: 0.9 }));
  const colliders: Collider[] = [];

  const lawn = new THREE.Mesh(geo(new THREE.CylinderGeometry(18, 18.7, 0.7, 80)), [
    earth,
    grass,
    dirt,
  ]);
  lawn.position.y = -0.35;
  lawn.receiveShadow = true;
  scene.add(lawn);

  const loop = new THREE.Mesh(geo(new THREE.RingGeometry(7.15, 9.05, 80)), path);
  loop.rotation.x = -Math.PI / 2;
  loop.position.y = 0.02;
  loop.receiveShadow = true;
  scene.add(loop);

  const entrance = new THREE.Mesh(geo(new THREE.BoxGeometry(2.1, 0.04, 8.4)), path);
  entrance.position.set(0, 0.02, 12.6);
  entrance.receiveShadow = true;
  scene.add(entrance);

  const plaza = new THREE.Mesh(geo(new THREE.CircleGeometry(4.7, 48)), stone);
  plaza.rotation.x = -Math.PI / 2;
  plaza.position.y = 0.03;
  plaza.receiveShadow = true;
  scene.add(plaza);

  addGazebo(THREE, scene, geo, mat, wood, roof, colliders);
  const seats = addBenches(THREE, scene, geo, wood, metal, colliders);
  addSign(THREE, scene, geo, mat, woodDark, textures, colliders);
  addPond(THREE, scene, geo, mat, water, path, colliders);
  addPicnic(THREE, scene, geo, wood, metal, colliders);
  addHammock(THREE, scene, geo, mat, textures);
  addTrees(THREE, scene, geo, trunk, leafMats, idlers, colliders);
  addFlowers(THREE, scene, geo, mat, mobile);
  addPool(THREE, scene, geo, mat, poolWater, textures, colliders);
  addFence(THREE, scene, geo, woodDark);
  addHorizon(THREE, scene, geo, mat, mobile);
  addIceCream(THREE, scene, geo, mat, wood, textures, colliders);
  const ping = addPingPong(THREE, scene, geo, mat, colliders);
  addCards(THREE, scene, geo, mat);
  addLamps(THREE, scene, geo, mat, woodDark, colliders);
  const station = addPoliceStation(THREE, scene, geo, mat, wood, metal, textures, colliders);
  const stationSeats = station.seats;
  for (const seat of stationSeats) seats.push(seat);
  const pickups = addLoot(THREE, scene, geo, mat, textures);
  addSky(THREE, scene, mat, textures, sun.position, mobile);
  addTufts(THREE, scene, geo, mat, textures, mobile ? 46 : 100);
  const cast: Actor[] = [];
  const people: Collider[] = [];
  colliders.push(station.footprint);
  const { walkers, speakers, scooters } = addResidents(
    THREE,
    scene,
    rigs,
    clone,
    cast,
    characterDisposables,
    people,
    colliders,
    stationSeats[0] ?? null,
  );
  colliders.splice(colliders.indexOf(station.footprint), 1);
  postPeople(THREE, scene, rigs, clone, cast, characterDisposables, people, speakers);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.material) return;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      const standard = material as THREE.MeshStandardMaterial;
      if (!standard.isMeshStandardMaterial) continue;
      if (standard.envMapIntensity === 1) standard.envMapIntensity = 0.5;
      if (standard.map) standard.map.anisotropy = aniso;
    }
  });
  const seed = Math.floor(Math.random() * 1_000_000);
  const myLook = [
    seed % SKINS.length,
    (seed >> 3) % HAIRS.length,
    (seed >> 6) % CLOTHES.length,
    (seed >> 9) % 2,
  ];
  const player = spawnActor(THREE, myLook[3] === 1 ? rigs.female : rigs.male, clone, characterDisposables, lookFromCodes(myLook), false);
  const lane = (seed % 5) - 2;
  player.group.position.set(lane * 0.72, player.group.position.y, 16.2 + (seed % 3) * 0.18);
  attachTalkBubble(THREE, player, characterDisposables);
  scene.add(player.group);
  cast.push(player);
  const standY = player.group.position.y;
  const hipBone = player.group.getObjectByName("Hips");
  const hipPoint = new THREE.Vector3();
  if (hipBone) hipBone.getWorldPosition(hipPoint);
  const hipAboveRoot = hipBone ? hipPoint.y - standY : 0.92;
  const sitY = 0.58 - hipAboveRoot;
  const playerBody: Collider = { x: player.group.position.x, z: player.group.position.z, r: 0.42, owner: player };
  people.push(playerBody);
  yaw = Math.atan2(-(2.15 - player.group.position.x), -(14.05 - player.group.position.z));
  bodyYaw = yaw + Math.PI;
  player.facing = bodyYaw;
  player.role = "player";
  let sitting = false;
  let sitLock = 0;
  const remotes = new Map<string, Remote>();
  const roomWanted = PARK_ROOM;
  const myName = session.name;
  let selfId = "";
  const listPeople = () =>
    bridge.setPeople([...remotes.entries()].map(([id, remote]) => ({ id, name: remote.name })));
  const speakOver = (actor: Actor, text: string) => {
    if (!actor.bubble) attachTalkBubble(THREE, actor, characterDisposables);
    if (!actor.bubble) return;
    paintBubble(actor.bubble, text);
    actor.bubble.visible = true;
    actor.talking = 4.4;
  };
  player.group.add(nameTag(THREE, characterDisposables, myName, player.group.scale.y));
  const poseCode: Record<Pose, number> = { idle: 0, walk: 1, run: 2, play: 3 };
  const poseFromCode: Pose[] = ["idle", "walk", "run", "play"];
  let onlineCount = 1;
  let roomName = "";
  let netStatus: "connecting" | "online" | "offline" = "connecting";
  const pushOnline = () => bridge.setOnline({ status: netStatus, count: onlineCount, room: roomName });
  const addRemote = (info: NetPlayer) => {
    if (remotes.has(info.id) || remotes.size >= 32) return;
    const codes = info.look ?? [];
    const actor = spawnActor(THREE, codes[3] === 1 ? rigs.female : rigs.male, clone, characterDisposables, lookFromCodes(codes), false);
    actor.role = "player";
    const [x, z, yaw, pose, seated] = info.d ?? [0, 16, 0, 0, 0];
    actor.group.position.set(x, actor.group.position.y, z);
    actor.group.rotation.y = yaw;
    actor.facing = yaw;
    actor.seated = seated === 1;
    if (actor.seated) actor.group.position.y = sitY;
    actor.group.add(nameTag(THREE, characterDisposables, info.name || "Guest", actor.group.scale.y));
    attachTalkBubble(THREE, actor, characterDisposables);
    scene.add(actor.group);
    cast.push(actor);
    const body: Collider = { x, z, r: 0.42, owner: actor, fixed: true };
    people.push(body);
    remotes.set(info.id, {
      actor,
      body,
      target: { x, z, yaw },
      pose: poseFromCode[pose] ?? "idle",
      name: info.name || "Guest",
    });
  };
  const removeRemote = (id: string) => {
    const remote = remotes.get(id);
    if (!remote) return;
    remotes.delete(id);
    scene.remove(remote.actor.group);
    const castIndex = cast.indexOf(remote.actor);
    if (castIndex >= 0) cast.splice(castIndex, 1);
    const bodyIndex = people.indexOf(remote.body);
    if (bodyIndex >= 0) people.splice(bodyIndex, 1);
    remote.actor.group.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) {
        if (characterDisposables.delete(material)) material.dispose();
      }
    });
  };
  const clearRemotes = () => {
    for (const id of [...remotes.keys()]) removeRemote(id);
  };
  const net = connectRelay(roomWanted, myName, myLook, [player.group.position.x, player.group.position.z, bodyYaw, 0, 0], {
    onStatus: (status) => {
      netStatus = status;
      if (status !== "online") {
        clearRemotes();
        onlineCount = 1;
        listPeople();
      }
      pushOnline();
    },
    onWelcome: (self, room, players) => {
      clearRemotes();
      selfId = self;
      roomName = room;
      for (const info of players) addRemote(info);
      onlineCount = players.length + 1;
      pushOnline();
      listPeople();
      bridge.pushChat({
        from: "",
        system: true,
        text: players.length === 0
          ? "You're in the park. Anyone who opens this site walks in here."
          : `You're in the park with ${players.length} ${players.length === 1 ? "person" : "people"}.`,
      });
    },
    onJoin: (info) => {
      addRemote(info);
      onlineCount = remotes.size + 1;
      pushOnline();
      listPeople();
      bridge.pushChat({ from: "", system: true, text: `${info.name || "Someone"} walked in.` });
    },
    onLeave: (id) => {
      const leaving = remotes.get(id)?.name ?? "Someone";
      removeRemote(id);
      onlineCount = remotes.size + 1;
      pushOnline();
      listPeople();
      bridge.pushChat({ from: "", system: true, text: `${leaving} headed out.` });
    },
    onChat: (message) => {
      if (message.id === selfId) return;
      const remote = remotes.get(message.id);
      if (remote) speakOver(remote.actor, message.text);
      bridge.pushChat({ from: message.name, text: message.text });
    },
    onUpdate: (updates, count) => {
      for (const [id, x, z, yaw, pose, seated] of updates) {
        const remote = remotes.get(id);
        if (!remote) continue;
        remote.target.x = x;
        remote.target.z = z;
        remote.target.yaw = yaw;
        remote.pose = poseFromCode[pose] ?? "idle";
        const nowSeated = seated === 1;
        if (nowSeated !== remote.actor.seated) {
          remote.actor.seated = nowSeated;
          remote.actor.group.position.y = nowSeated ? sitY : standY;
        }
      }
      if (count > 0 && count !== onlineCount) {
        onlineCount = count;
        pushOnline();
      }
    },
  });
  const stash = loadStash();
  let cash = stash.cash;
  let items: BagItem[] = stash.items.map((item) => ({ ...item }));
  let hasGun = items.some((item) => item.kind === "gun");
  const creamVendor = speakers.find((actor) => actor.lines.some((line) => /Vanilla|scoop/i.test(line)));
  const pushPocket = () => {
    hasGun = items.some((item) => item.kind === "gun");
    saveStash(cash, items);
    bridge.setPocket({ cash, gun: hasGun, items: items.map((item) => ({ ...item })) });
  };
  pushPocket();
  const ownItem = (kind: BagItem["kind"], qty = 1) => {
    const existing = items.find((item) => item.kind === kind);
    if (existing) existing.qty += qty;
    else items.push({ kind, name: ITEM_NAME[kind], qty });
    pushPocket();
  };
  const spendItem = (kind: BagItem["kind"]) => {
    const existing = items.find((item) => item.kind === kind);
    if (!existing) return false;
    existing.qty -= 1;
    if (existing.qty <= 0) items = items.filter((item) => item !== existing);
    pushPocket();
    return true;
  };
  let hitLock = 0;
  let playerSwing = 0;
  const questDone: Record<string, boolean> = {};
  for (const quest of QUEST_LIST) questDone[quest.id] = false;
  const follow = { ready: false, position: new THREE.Vector3() };

  const standUp = () => {
    if (!sitting) return;
    sitting = false;
    sitLock = 0;
    player.seated = false;
    player.group.position.y = standY;
    bridge.setSitting(false);
    bridge.setNotice(null);
    noticeLeft = 0;
  };
  const tryBuy = () => {
    if (!creamVendor) return false;
    const distance = Math.hypot(creamVendor.group.position.x - player.group.position.x, creamVendor.group.position.z - player.group.position.z);
    if (distance > 2.4) return false;
    if (cash < 8) {
      flash("A scoop is $8. That's yours once you pay.");
      return true;
    }
    cash -= 8;
    ownItem("cream");
    flash("That's yours. A scoop from the stand.");
    noticeLeft = 2.4;
    return true;
  };
  trySit = () => {
    if (tryBuy()) return;
    if (sitting) {
      standUp();
      return;
    }
    let closest: { x: number; z: number; facing: number } | null = null;
    let best = 5.5;
    for (const seat of seats) {
      const distance = Math.hypot(seat.nearX - player.group.position.x, seat.nearZ - player.group.position.z);
      if (distance < best) {
        best = distance;
        closest = seat;
      }
    }
    if (!closest) {
      bridge.setNotice("Walk up to a bench, then press Sit");
      noticeLeft = 2.4;
      return;
    }
    sitting = true;
    sitLock = 0.45;
    player.seated = true;
    player.group.position.set(closest.x, sitY, closest.z);
    bodyYaw = closest.facing;
    yaw = bodyYaw - Math.PI;
    player.group.rotation.y = bodyYaw;
    player.facing = bodyYaw;
    playerBody.x = closest.x;
    playerBody.z = closest.z;
    playerBody.fixed = true;
    motion.f = 0;
    motion.s = 0;
    wheelMove = 0;
    bridge.setNotice(null);
    noticeLeft = 0;
    bridge.setSitting(true);
  };
  const flash = (text: string) => {
    bridge.setNotice(text);
    noticeLeft = 2.4;
  };
  tryHit = () => {
    if (hitLock > 0 || sitting) return;
    let target: Actor | null = null;
    let best = 2.6;
    const spot = new THREE.Vector3();
    for (const actor of cast) {
      if (actor === player) continue;
      actor.group.getWorldPosition(spot);
      const distance = Math.hypot(spot.x - player.group.position.x, spot.z - player.group.position.z);
      if (distance < best) {
        best = distance;
        target = actor;
      }
    }
    if (!target) {
      flash("Walk up to someone, then press Hit");
      return;
    }
    hitLock = 0.85;
    playerSwing = 0.7;
    setPose(player, "play");
    target.stagger = 0.85;
    setPose(target, "idle");
    const ride = scooters.find((scooter) => scooter.rider === target);
    if (!target.seated || ride) {
      target.group.getWorldPosition(spot);
      const awayX = spot.x - player.group.position.x;
      const awayZ = spot.z - player.group.position.z;
      const away = Math.hypot(awayX, awayZ) || 1;
      const shove = hasGun ? 0.7 : 0.4;
      const nextX = spot.x + (awayX / away) * shove;
      const nextZ = spot.z + (awayZ / away) * shove;
      const body = ride ? ride.collider : people.find((entry) => entry.owner === target);
      const cleared = resolveCircle(nextX, nextZ, body?.r ?? 0.46, colliders.concat(people.filter((entry) => entry !== body)));
      if (ride) {
        ride.group.position.x = cleared.x;
        ride.group.position.z = cleared.z;
        ride.collider.x = cleared.x;
        ride.collider.z = cleared.z;
      } else if (body && !target.seated) {
        target.group.position.x = cleared.x;
        target.group.position.z = cleared.z;
        body.x = cleared.x;
        body.z = cleared.z;
      }
    }
    combatUntil = 4.5;
    flash(hasGun ? "They back off." : "They stumble.");
  };
  tryWave = () => {
    if (sitting || playerSwing > 0) return;
    playerSwing = 0.9;
    setPose(player, "play");
    flash("You wave.");
    noticeLeft = 1.4;
  };
  tryJump = () => {
    if (sitting || airY > 0.04 || dodgeLeft > 0) return;
    crouching = false;
    airV = 6.5;
  };
  tryDodge = () => {
    if (sitting || dodgeLeft > 0 || airY > 0.1) return;
    const heading = Math.hypot(motion.f, motion.s) > 0.15
      ? Math.atan2(-Math.sin(yaw) * motion.f + Math.cos(yaw) * motion.s, -Math.cos(yaw) * motion.f - Math.sin(yaw) * motion.s)
      : yaw + Math.PI;
    dodgeX = Math.sin(heading);
    dodgeZ = Math.cos(heading);
    dodgeLeft = 0.34;
    playerSwing = 0.34;
    setPose(player, "play");
  };

  function setView(next: ViewMode) {
    view = next;
    if (next === "first") yaw = bodyYaw - Math.PI;
    player.group.visible = next === "third";
    follow.ready = false;
    bridge.setViewMode(next);
  }
  setView("third");
  bridge.bind({
    sit: () => trySit(),
    setView: (mode) => setView(mode),
    toggleMusic: () => {
      parkAudio.toggle();
      syncAudio();
    },
    setStick: (x, y) => {
      stick.x = x;
      stick.y = y;
    },
    pokeAudio: () => {
      parkAudio.start();
      syncAudio();
    },
    setRun: (down) => {
      buttonRun = down;
    },
    hit: () => tryHit(),
    wave: () => tryWave(),
    jump: () => tryJump(),
    dodge: () => tryDodge(),
    setAim: (down) => {
      aiming = down;
      bridge.setAiming(down);
    },
    setCrouch: (down) => {
      crouching = down;
    },
    useItem: (kind) => {
      if (kind === "cream") {
        if (!spendItem("cream")) return;
        flash("You eat your scoop.");
        return;
      }
      if (kind === "gun") {
        if (!items.some((item) => item.kind === "gun")) return;
        hasGun = true;
        flash("That's your gun.");
        return;
      }
      if (kind === "flower") {
        if (!items.some((item) => item.kind === "flower")) return;
        flash("You keep the flower. It's yours.");
        return;
      }
      if (kind === "shades") {
        if (!items.some((item) => item.kind === "shades")) return;
        flash("You put on your shades.");
      }
    },
    chat: (text) => {
      const ok = net.chat(text, performance.now());
      if (!ok) return false;
      speakOver(player, text);
      bridge.pushChat({ from: myName, text, self: true });
      return true;
    },
  });

  const resize = () => {
    const w = host.clientWidth || window.innerWidth;
    const h = host.clientHeight || window.innerHeight;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  let frame = 0;
  const timer = new THREE.Timer();
  const tick = () => {
    timer.update();
    const t = timer.getElapsed();
    const delta = Math.min(timer.getDelta(), 0.05);
    water.uniforms.uTime.value = t;
    poolWater.uniforms.uTime.value = t;
    const rally = 0.5 + 0.5 * Math.sin(t * 2.4);
    ping.ball.position.set(
      ping.from.x + (ping.to.x - ping.from.x) * rally,
      1.05 + Math.abs(Math.sin(t * 4.8)) * 0.45,
      ping.from.z + (ping.to.z - ping.from.z) * rally,
    );
    for (const idle of idlers) {
      if (idle.sway) idle.sway.rotation.z = Math.sin(t * 0.7 + idle.phase) * 0.04;
    }
    for (const remote of remotes.values()) {
      const follow = 1 - Math.exp(-12 * delta);
      remote.body.x += (remote.target.x - remote.body.x) * follow;
      remote.body.z += (remote.target.z - remote.body.z) * follow;
      const turn = Math.atan2(Math.sin(remote.target.yaw - remote.actor.facing), Math.cos(remote.target.yaw - remote.actor.facing));
      remote.actor.facing += turn * follow;
      remote.actor.group.rotation.y = remote.actor.facing;
      if (remote.actor.seated) {
        remote.actor.group.position.x = remote.target.x;
        remote.actor.group.position.z = remote.target.z;
        remote.body.x = remote.target.x;
        remote.body.z = remote.target.z;
      } else {
        remote.actor.group.position.x = remote.body.x;
        remote.actor.group.position.z = remote.body.z;
      }
      setPose(remote.actor, remote.actor.seated ? "idle" : remote.pose);
    }
    for (const scooter of scooters) stepScooter(scooter, delta, colliders, people);
    for (const walker of walkers) stepWalker(walker, delta, player.group.position, colliders, people);
    if (noticeLeft > 0) {
      noticeLeft = Math.max(0, noticeLeft - delta);
      if (noticeLeft === 0) bridge.setNotice(null);
    }
    for (const pickup of pickups) {
      if (pickup.taken) continue;
      pickup.mesh.position.y = 0.42 + Math.sin(t * 2.2 + pickup.x) * 0.05;
      if (Math.hypot(pickup.x - player.group.position.x, pickup.z - player.group.position.z) > 1.25) continue;
      pickup.taken = true;
      pickup.mesh.visible = false;
      if (pickup.kind === "cash") {
        cash += pickup.amount;
        pushPocket();
        flash(`That's yours. $${pickup.amount}.`);
      } else {
        ownItem(pickup.kind);
        flash(`That's yours. ${ITEM_NAME[pickup.kind]}.`);
      }
      noticeLeft = 2.4;
    }
    const pad = typeof navigator !== "undefined" ? navigator.getGamepads?.()[0] : null;
    const dead = (value: number) => (Math.abs(value) < 0.18 ? 0 : value);
    let padSprint = false;
    let padAim = false;
    let moveX = stick.x;
    let moveY = stick.y;
    if (pad) {
      if (Math.abs(moveX) < 0.04) moveX = dead(pad.axes[0] ?? 0);
      if (Math.abs(moveY) < 0.04) moveY = -dead(pad.axes[1] ?? 0);
      padLook.x = dead(pad.axes[2] ?? 0);
      padLook.y = dead(pad.axes[3] ?? 0);
      padSprint = Boolean(pad.buttons[7]?.pressed);
      padAim = Boolean(pad.buttons[6]?.pressed);
      const edge = (held: boolean, slot: keyof typeof padPrev, fn: () => void) => {
        if (held && !padPrev[slot]) fn();
        padPrev[slot] = held;
      };
      edge(Boolean(pad.buttons[0]?.pressed), "jump", tryJump);
      edge(Boolean(pad.buttons[4]?.pressed), "dodge", tryDodge);
      edge(Boolean(pad.buttons[2]?.pressed), "sit", trySit);
      edge(Boolean(pad.buttons[3]?.pressed), "wave", tryWave);
      edge(Boolean(pad.buttons[5]?.pressed), "hit", tryHit);
    } else {
      padLook.x = 0;
      padLook.y = 0;
      padPrev.jump = false;
      padPrev.dodge = false;
      padPrev.sit = false;
      padPrev.wave = false;
      padPrev.hit = false;
    }
    const isAiming = aiming || padAim;
    crouching = keys.crouch || Boolean(pad?.buttons[1]?.pressed);
    if (cinematic <= 0) {
      yaw -= padLook.x * (isAiming ? 1.6 : 2.2) * delta;
      pitch = Math.max(-0.72, Math.min(0.62, pitch - padLook.y * (isAiming ? 1.3 : 1.8) * delta));
    }
    combatUntil = Math.max(0, combatUntil - delta);
    cinematic = Math.max(0, cinematic - delta);
    wheelMove *= Math.exp(-2.6 * delta);
    let inputF = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0) + wheelMove + moveY;
    let inputS = (keys.right ? 1 : 0) - (keys.left ? 1 : 0) + moveX;
    const inputMag = Math.hypot(inputF, inputS);
    if (inputMag > 1) {
      inputF /= inputMag;
      inputS /= inputMag;
    }
    const ease = 1 - Math.exp(-(isAiming ? 12 : 9) * delta);
    motion.f += (inputF - motion.f) * ease;
    motion.s += (inputS - motion.s) * ease;
    const movingAmount = Math.hypot(motion.f, motion.s);
    sitLock = Math.max(0, sitLock - delta);
    const wantsMove = movingAmount > 0.18 && sitLock <= 0;
    if (wantsMove && sitting) standUp();
    const moving = wantsMove && !sitting;
    const sprinting = moving && (keys.run || mouseRun || buttonRun || padSprint);
    const running = moving && !sprinting && movingAmount > 0.58;
    const forwardX = -Math.sin(yaw);
    const forwardZ = -Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    if (dodgeLeft > 0) {
      const dash = 11.5 * delta;
      const next = steer(
        player.group.position.x,
        player.group.position.z,
        player.group.position.x + dodgeX * dash,
        player.group.position.z + dodgeZ * dash,
        0.42,
        colliders,
        people,
        playerBody,
      );
      player.group.position.x = next.x;
      player.group.position.z = next.z;
      dodgeLeft = Math.max(0, dodgeLeft - delta);
    } else if (moving) {
      const speed = crouching ? 2.15 : sprinting ? 8.8 : running ? 6.15 : 4.35;
      const step = speed * movingAmount * delta;
      const moveX = forwardX * motion.f + rightX * motion.s;
      const moveZ = forwardZ * motion.f + rightZ * motion.s;
      const moveLen = Math.hypot(moveX, moveZ) || 1;
      const next = steer(
        player.group.position.x,
        player.group.position.z,
        player.group.position.x + (moveX / moveLen) * step,
        player.group.position.z + (moveZ / moveLen) * step,
        crouching ? 0.38 : 0.42,
        colliders,
        people,
        playerBody,
      );
      player.group.position.x = next.x;
      player.group.position.z = next.z;
      const reach = Math.hypot(player.group.position.x, player.group.position.z);
      const limit = 16.6;
      if (reach > limit) {
        player.group.position.x *= limit / reach;
        player.group.position.z *= limit / reach;
      }
      if (isAiming) {
        const desired = yaw + Math.PI;
        const diff = Math.atan2(Math.sin(desired - bodyYaw), Math.cos(desired - bodyYaw));
        bodyYaw += diff * (1 - Math.exp(-10 * delta));
      } else {
        const desired = Math.atan2(moveX, moveZ);
        const diff = Math.atan2(Math.sin(desired - bodyYaw), Math.cos(desired - bodyYaw));
        bodyYaw += diff * (1 - Math.exp(-12 * delta));
      }
    } else if (isAiming && !sitting) {
      const desired = yaw + Math.PI;
      const diff = Math.atan2(Math.sin(desired - bodyYaw), Math.cos(desired - bodyYaw));
      bodyYaw += diff * (1 - Math.exp(-10 * delta));
    }
    airV -= 22 * delta;
    airY = Math.max(0, airY + airV * delta);
    if (airY === 0) airV = Math.max(airV, 0);
    player.group.position.y = sitting ? sitY : standY + airY - (crouching && airY === 0 ? 0.28 : 0);
    playerBody.x = player.group.position.x;
    playerBody.z = player.group.position.z;
    playerBody.fixed = sitting;
    separatePeople(people);
    for (const body of people) {
      if (!body.fixed && body.owner) {
        const cleared = resolveCircle(body.x, body.z, body.r, colliders);
        body.x = cleared.x;
        body.z = cleared.z;
        const reach = Math.hypot(body.x, body.z);
        if (reach > 16.6) {
          body.x *= 16.6 / reach;
          body.z *= 16.6 / reach;
        }
      }
      if (body.owner && !body.owner.seated) {
        body.owner.group.position.x = body.x;
        body.owner.group.position.z = body.z;
      }
    }
    for (const scooter of scooters) {
      scooter.group.position.x = scooter.collider.x;
      scooter.group.position.z = scooter.collider.z;
      scooter.group.rotation.y = scooter.rider.facing;
      const wheels = scooter.group.userData.wheels as THREE.Object3D[] | undefined;
      if (wheels && scooter.pause <= 0 && scooter.rider.stagger <= 0) {
        for (const wheel of wheels) wheel.rotateX(scooter.speed * delta * 3);
      }
    }
    hitLock = Math.max(0, hitLock - delta);
    if (playerSwing > 0) {
      playerSwing = Math.max(0, playerSwing - delta);
      setPose(player, "play");
      if (playerSwing === 0) setPose(player, "idle");
    } else if (airY > 0.08) {
      setPose(player, "idle");
    } else {
      setPose(player, sitting || crouching ? "idle" : sprinting ? "run" : moving ? "walk" : "idle");
    }
    player.actions.walk.setEffectiveTimeScale(1.55 + movingAmount * 0.35);
    player.actions.run.setEffectiveTimeScale(1.35 + movingAmount * 0.25);
    updateQuests(questDone, player.group.position, sitting, speakers, (title) => {
      bridge.setQuests(QUEST_LIST.map((quest) => ({ ...quest, done: questDone[quest.id] })));
      bridge.setQuestToast(title);
      cinematic = 2.4;
    });
    if (!sitting) {
      player.group.rotation.y = bodyYaw;
      player.facing = bodyYaw;
    }
    const someoneTalking = updateTalk(speakers, player.group.position, delta, parkAudio);
    parkAudio.duck(someoneTalking);
    const fadeBubble = (actor: Actor) => {
      if (actor.talking <= 0) return;
      actor.talking = Math.max(0, actor.talking - delta);
      if (actor.bubble) actor.bubble.visible = actor.talking > 0;
    };
    fadeBubble(player);
    for (const remote of remotes.values()) fadeBubble(remote.actor);
    for (const actor of cast) {
      actor.mixer.update(delta);
      if (actor.seated) applySit(actor.group);
    }
    if (crouching && !sitting && airY <= 0) applyCrouch(player.group);
    net.send(
      [player.group.position.x, player.group.position.z, bodyYaw, poseCode[player.pose], sitting ? 1 : 0],
      t * 1000,
    );
    let camMode: CamMode = "explore";
    if (cinematic > 0) camMode = "cinematic";
    else if (isAiming) camMode = "aim";
    else if (hasGun || combatUntil > 0) camMode = "combat";
    else {
      const px = player.group.position.x;
      const pz = player.group.position.z;
      let nearThing = false;
      for (const seat of seats) {
        if (Math.hypot(seat.nearX - px, seat.nearZ - pz) < 2.3) nearThing = true;
      }
      if (!nearThing) {
        for (const pickup of pickups) {
          if (!pickup.taken && Math.hypot(pickup.x - px, pickup.z - pz) < 2.1) nearThing = true;
        }
      }
      if (nearThing && !sitting) camMode = "interact";
    }
    placeCamera(camera, player.group.position, yaw, pitch, view, camMode, delta, follow, colliders, camDist, camPos, lookAt, boomDir);
    renderer.render(scene, camera);
    frame = requestAnimationFrame(tick);
  };
  tick();

  return () => {
    cancelAnimationFrame(frame);
    observer.disconnect();
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("pointerdown", onRunButton);
    window.removeEventListener("pointerup", onRunButton);
    window.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onLockChange);
    renderer.domElement.removeEventListener("click", onClick);
    renderer.domElement.removeEventListener("wheel", onWheel);
    renderer.domElement.removeEventListener("pointerdown", onPointerDown);
    renderer.domElement.removeEventListener("pointermove", onPointerMove);
    renderer.domElement.removeEventListener("pointerup", onPointerUp);
    renderer.domElement.removeEventListener("pointercancel", onPointerUp);
    if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
    net.close();
    parkAudio.stop();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());
    characterDisposables.forEach((resource) => resource.dispose());
    envMap?.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}

function grassTexture(
  THREE: typeof import("three"),
  textures: THREE.Texture[],
  compact = false,
) {
  const size = compact ? 256 : 1024;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const fallback = new THREE.CanvasTexture(canvas);
    textures.push(fallback);
    return fallback;
  }
  const lawn = ctx.createLinearGradient(0, 0, size, size);
  lawn.addColorStop(0, "#4c8a38");
  lawn.addColorStop(0.5, "#5ea246");
  lawn.addColorStop(1, "#3f7a32");
  ctx.fillStyle = lawn;
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < (compact ? 280 : 1800); i += 1) {
    const n = seeded(i * 1.7);
    const shade = n > 0.5 ? 40 + n * 70 : 20 + n * 40;
    ctx.fillStyle = `rgba(${18 + n * 24}, ${shade}, ${16 + n * 12}, 0.22)`;
    ctx.fillRect(seeded(i + 4) * size, seeded(i + 11) * size, 3 + n * 8, 3 + n * 6);
  }
  for (let i = 0; i < (compact ? 40 : 140); i += 1) {
    ctx.fillStyle = i % 3 === 0 ? "rgba(92,68,34,0.14)" : "rgba(220,196,96,0.08)";
    ctx.beginPath();
    ctx.ellipse(seeded(i + 2) * size, seeded(i + 9) * size, 18 + seeded(i) * 46, 10 + seeded(i + 4) * 20, seeded(i + 6) * 6, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < (compact ? 900 : 9000); i += 1) {
    const n = seeded(i + 21);
    const lean = (n - 0.5) * 1.1;
    ctx.strokeStyle = n > 0.84 ? "rgba(186,154,64,0.4)" : n > 0.5 ? "rgba(24,78,22,0.55)" : "rgba(118,168,58,0.38)";
    ctx.lineWidth = n > 0.75 ? 1.6 : 1;
    ctx.beginPath();
    const x = seeded(i + 3) * size;
    const y = seeded(i + 8) * size;
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + lean * 10, y - 8, x + lean * 18, y - (10 + n * 16));
    ctx.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(7, 7);
  texture.anisotropy = 8;
  textures.push(texture);
  return texture;
}

function resolveCircle(x: number, z: number, radius: number, colliders: Collider[], ignore?: Collider) {
  let px = x;
  let pz = z;
  for (let pass = 0; pass < 3; pass += 1) {
    for (const collider of colliders) {
      if (collider === ignore) continue;
      if (collider.hx && collider.hz) {
        const rot = collider.rot ?? 0;
        const cos = Math.cos(rot);
        const sin = Math.sin(rot);
        const dx = px - collider.x;
        const dz = pz - collider.z;
        const lx = dx * cos + dz * sin;
        const lz = -dx * sin + dz * cos;
        const nearestX = Math.max(-collider.hx, Math.min(collider.hx, lx));
        const nearestZ = Math.max(-collider.hz, Math.min(collider.hz, lz));
        let offsetX = lx - nearestX;
        let offsetZ = lz - nearestZ;
        let distance = Math.hypot(offsetX, offsetZ);
        if (distance >= radius) continue;
        if (distance < 0.0001) {
          const spaceX = collider.hx - Math.abs(lx);
          const spaceZ = collider.hz - Math.abs(lz);
          const outX = spaceX < spaceZ ? (lx < 0 ? -1 : 1) * (collider.hx + radius) : lx;
          const outZ = spaceX < spaceZ ? lz : (lz < 0 ? -1 : 1) * (collider.hz + radius);
          px = collider.x + outX * cos - outZ * sin;
          pz = collider.z + outX * sin + outZ * cos;
          continue;
        }
        const push = radius - Math.min(distance, radius);
        const nx = offsetX / distance;
        const nz = offsetZ / distance;
        px += (nx * cos - nz * sin) * push;
        pz += (nx * sin + nz * cos) * push;
        continue;
      }
      const dx = px - collider.x;
      const dz = pz - collider.z;
      const limit = radius + collider.r;
      const distance = Math.hypot(dx, dz);
      if (distance >= limit) continue;
      if (distance < 0.0001) {
        px += limit;
        continue;
      }
      const push = limit - distance;
      px += (dx / distance) * push;
      pz += (dz / distance) * push;
    }
  }
  return { x: px, z: pz };
}

function steer(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
  radius: number,
  world: Collider[],
  people: Collider[],
  self: Collider,
  side = 1,
) {
  const blockers = world.concat(
    people.filter((body) => body !== self).map((body) => ({ ...body, r: body.r + CROWD_GAP })),
  );
  const direct = resolveCircle(targetX, targetZ, radius, blockers);
  const dx = targetX - x;
  const dz = targetZ - z;
  const wanted = dx * dx + dz * dz || 1;
  const along = (direct.x - x) * dx + (direct.z - z) * dz;
  if (along > wanted * 0.5) return { x: direct.x, z: direct.z, side };

  const pushX = direct.x - targetX;
  const pushZ = direct.z - targetZ;
  const pushLen = Math.hypot(pushX, pushZ);
  if (pushLen > 0.0001) {
    const nx = pushX / pushLen;
    const nz = pushZ / pushLen;
    const approach = dx * nx + dz * nz;
    if (approach < 0) {
      const slide = resolveCircle(x + dx - nx * approach, z + dz - nz * approach, radius, blockers);
      if (Math.hypot(slide.x - x, slide.z - z) > 0.012) return { x: slide.x, z: slide.z, side };
    }
  }

  const length = Math.hypot(dx, dz) || 1;
  const offset = Math.max(0.32, length * 1.8);
  const sidestep = (sign: number) =>
    resolveCircle(x - (dz / length) * offset * sign, z + (dx / length) * offset * sign, radius, blockers);
  const preferred = sidestep(side);
  if (Math.hypot(preferred.x - x, preferred.z - z) > 0.02) return { x: preferred.x, z: preferred.z, side };
  const other = sidestep(-side);
  if (Math.hypot(other.x - x, other.z - z) > 0.02) return { x: other.x, z: other.z, side: -side };
  return { x: direct.x, z: direct.z, side: -side };
}

const CROWD_GAP = 0.34;

function crowdAim(
  x: number,
  z: number,
  targetX: number,
  targetZ: number,
  self: Collider,
  people: Collider[],
) {
  const dx = targetX - x;
  const dz = targetZ - z;
  const length = Math.hypot(dx, dz) || 1;
  const fx = dx / length;
  const fz = dz / length;
  let sideways = 0;
  for (const body of people) {
    if (body === self) continue;
    const ox = body.x - x;
    const oz = body.z - z;
    const ahead = ox * fx + oz * fz;
    if (ahead < 0 || ahead > 2.6) continue;
    const lateral = -ox * fz + oz * fx;
    const clearance = self.r + body.r + CROWD_GAP + 0.1;
    if (Math.abs(lateral) >= clearance) continue;
    const weight = (clearance - Math.abs(lateral)) * (1 - ahead / 2.6);
    sideways += (lateral >= 0 ? -1 : 1) * weight;
  }
  if (sideways === 0) return { x: targetX, z: targetZ };
  const shift = Math.max(-1.4, Math.min(1.4, sideways * 1.6));
  const reach = Math.min(length, 1.6);
  return {
    x: x + fx * reach - fz * shift,
    z: z + fz * reach + fx * shift,
  };
}

function separatePeople(people: Collider[]) {
  for (let pass = 0; pass < 2; pass += 1) {
    for (let i = 0; i < people.length; i += 1) {
      for (let j = i + 1; j < people.length; j += 1) {
        const a = people[i];
        const b = people[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const distance = Math.hypot(dx, dz) || 0.0001;
        const limit = a.r + b.r;
        if (distance >= limit) continue;
        const nx = dx / distance;
        const nz = dz / distance;
        const push = limit - distance;
        const pushA = b.fixed ? push : a.fixed ? 0 : push * 0.5;
        const pushB = a.fixed ? push : b.fixed ? 0 : push * 0.5;
        a.x -= nx * pushA;
        a.z -= nz * pushA;
        b.x += nx * pushB;
        b.z += nz * pushB;
      }
    }
  }
}

function addGazebo(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  wood: THREE.Material,
  roofMat: THREE.Material,
  colliders: Collider[],
) {
  const group = new THREE.Group();
  const postGeo = geo(new THREE.CylinderGeometry(0.09, 0.11, 2.05, 6));
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2 + Math.PI / 6;
    const post = new THREE.Mesh(postGeo, wood);
    post.position.set(Math.cos(angle) * 2.35, 1.02, Math.sin(angle) * 2.35);
    post.castShadow = true;
    group.add(post);
    colliders.push({ x: post.position.x, z: post.position.z, r: 0.28 });
  }
  const roof = new THREE.Mesh(geo(new THREE.ConeGeometry(3.25, 1.2, 6)), roofMat);
  roof.position.y = 2.55;
  roof.rotation.y = Math.PI / 6;
  roof.castShadow = true;
  group.add(roof);
  const finial = new THREE.Mesh(
    geo(new THREE.SphereGeometry(0.16, 10, 8)),
    mat(new THREE.MeshStandardMaterial({ color: 0xf6e27a })),
  );
  finial.position.y = 3.2;
  group.add(finial);
  scene.add(group);
}

function addBenches(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  wood: THREE.Material,
  metal: THREE.Material,
  colliders: Collider[],
) {
  const seats: Array<{ x: number; z: number; nearX: number; nearZ: number; facing: number }> = [];
  const seatGeo = geo(new THREE.BoxGeometry(1.45, 0.08, 0.46));
  const backGeo = geo(new THREE.BoxGeometry(1.45, 0.42, 0.08));
  const legGeo = geo(new THREE.BoxGeometry(0.08, 0.42, 0.08));
  for (let i = 0; i < 6; i += 1) {
    const angle = (i / 6) * Math.PI * 2;
    const bench = new THREE.Group();
    const seat = new THREE.Mesh(seatGeo, wood);
    seat.position.y = 0.46;
    seat.castShadow = true;
    const back = new THREE.Mesh(backGeo, wood);
    back.position.set(0, 0.72, -0.19);
    back.castShadow = true;
    bench.add(seat, back);
    for (const [x, z] of [
      [-0.58, 0.14],
      [0.58, 0.14],
      [-0.58, -0.14],
      [0.58, -0.14],
    ] as const) {
      const leg = new THREE.Mesh(legGeo, metal);
      leg.position.set(x, 0.21, z);
      bench.add(leg);
    }
    bench.position.set(Math.cos(angle) * 5.7, 0, Math.sin(angle) * 5.7);
    bench.lookAt(0, 0, 0);
    bench.rotateY(Math.PI);
    bench.updateMatrixWorld(true);
    scene.add(bench);
    colliders.push({
      x: bench.position.x,
      z: bench.position.z,
      r: 0,
      hx: 0.78,
      hz: 0.28,
      rot: bench.rotation.y,
    });
    const outward = new THREE.Vector3(0, 0, 1).applyQuaternion(bench.quaternion);
    const sit = new THREE.Vector3(0, 0, 0.02).applyMatrix4(bench.matrixWorld);
    seats.push({
      x: sit.x,
      z: sit.z,
      nearX: bench.position.x,
      nearZ: bench.position.z,
      facing: Math.atan2(outward.x, outward.z),
    });
  }
  return seats;
}

function addSign(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  wood: THREE.Material,
  textures: THREE.Texture[],
  colliders: Collider[],
) {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 384;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f7f1e4";
    ctx.fillRect(0, 0, 1024, 384);
    ctx.strokeStyle = "#8a5a32";
    ctx.lineWidth = 28;
    ctx.strokeRect(20, 20, 984, 344);
    ctx.fillStyle = "#1e3328";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let size = 128;
    do {
      ctx.font = `700 ${size}px Georgia, "Times New Roman", serif`;
      size -= 4;
    } while (ctx.measureText("THE HANGOUT").width > 900 && size > 64);
    ctx.fillText("THE HANGOUT", 512, 200);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  textures.push(texture);
  const boardMat = mat(new THREE.MeshStandardMaterial({ map: texture }));
  const plain = mat(new THREE.MeshStandardMaterial({ color: 0xf7f1e4 }));
  const sign = new THREE.Group();
  const board = new THREE.Mesh(geo(new THREE.BoxGeometry(2.7, 0.95, 0.1)), [
    plain,
    plain,
    plain,
    plain,
    boardMat,
    plain,
  ]);
  board.position.set(0, 1.55, 0);
  board.castShadow = true;
  sign.add(board);
  const postGeo = geo(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 6));
  for (const x of [-1.18, 1.18]) {
    const post = new THREE.Mesh(postGeo, wood);
    post.position.set(x, 0.55, -0.04);
    post.castShadow = true;
    sign.add(post);
  }
  sign.position.set(2.15, 0, 14.05);
  sign.rotation.y = -0.5;
  scene.add(sign);
  colliders.push({ x: 2.15, z: 14.05, r: 0, hx: 1.42, hz: 0.22, rot: -0.5 });
}

function addPond(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  water: THREE.Material,
  sand: THREE.Material,
  colliders: Collider[],
) {
  const shore = new THREE.Mesh(geo(new THREE.CircleGeometry(3.55, 40)), sand);
  shore.rotation.x = -Math.PI / 2;
  shore.position.set(10.2, 0.025, -2.2);
  shore.receiveShadow = true;
  const bed = new THREE.Mesh(
    geo(new THREE.CircleGeometry(2.85, 40)),
    mat(new THREE.MeshStandardMaterial({ color: 0x3b5a4a, roughness: 1 })),
  );
  bed.rotation.x = -Math.PI / 2;
  bed.position.set(10.2, 0.032, -2.2);
  const pond = new THREE.Mesh(geo(new THREE.CircleGeometry(2.85, 40)), water);
  pond.rotation.x = -Math.PI / 2;
  pond.position.set(10.2, 0.046, -2.2);
  scene.add(shore, bed, pond);
  colliders.push({ x: 10.2, z: -2.2, r: 2.7 });

  const rockMat = mat(new THREE.MeshStandardMaterial({ color: 0x8d8a82, roughness: 0.95, flatShading: true }));
  const rockGeo = geo(new THREE.DodecahedronGeometry(0.22, 0));
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 30);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 30; i += 1) {
    const a = (i / 30) * Math.PI * 2 + seeded(i) * 0.12;
    const r = 2.95 + seeded(i + 40) * 0.25;
    const s = 0.75 + seeded(i + 80) * 0.7;
    dummy.position.set(10.2 + Math.cos(a) * r, 0.06 * s, -2.2 + Math.sin(a) * r);
    dummy.scale.set(s * 1.3, s * 0.7, s);
    dummy.rotation.set(seeded(i + 3) * 3, seeded(i + 9) * 3, 0);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  scene.add(rocks);

  const padMat = mat(new THREE.MeshStandardMaterial({ color: 0x3e9a46 }));
  const padGeo = geo(new THREE.CircleGeometry(0.28, 10));
  for (const [x, z] of [
    [9.3, -1.6],
    [11.1, -2.6],
    [10.4, -3.2],
  ] as const) {
    const pad = new THREE.Mesh(padGeo, padMat);
    pad.rotation.x = -Math.PI / 2;
    pad.position.set(x, 0.05, z);
    scene.add(pad);
  }

  const reedMat = mat(new THREE.MeshStandardMaterial({ color: 0x2f7d38 }));
  const reedGeo = geo(new THREE.CylinderGeometry(0.03, 0.04, 0.7, 5));
  for (const [x, z] of [
    [8.1, -3.6],
    [8.4, -4.1],
    [12.4, -0.6],
    [12.7, -1.1],
  ] as const) {
    const reed = new THREE.Mesh(reedGeo, reedMat);
    reed.position.set(x, 0.35, z);
    scene.add(reed);
  }
}

function addPicnic(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  wood: THREE.Material,
  metal: THREE.Material,
  colliders: Collider[],
) {
  const table = new THREE.Group();
  const top = new THREE.Mesh(geo(new THREE.BoxGeometry(1.8, 0.08, 0.9)), wood);
  top.position.y = 0.72;
  top.castShadow = true;
  table.add(top);
  const legGeo = geo(new THREE.BoxGeometry(0.08, 0.7, 0.08));
  for (const [x, z] of [
    [-0.7, -0.3],
    [0.7, -0.3],
    [-0.7, 0.3],
    [0.7, 0.3],
  ] as const) {
    const leg = new THREE.Mesh(legGeo, metal);
    leg.position.set(x, 0.35, z);
    table.add(leg);
  }
  const seatGeo = geo(new THREE.BoxGeometry(1.6, 0.07, 0.32));
  for (const z of [-0.72, 0.72]) {
    const seat = new THREE.Mesh(seatGeo, wood);
    seat.position.set(0, 0.46, z);
    seat.castShadow = true;
    table.add(seat);
  }
  table.position.set(-9.2, 0, 3.2);
  table.rotation.y = 0.4;
  scene.add(table);
  colliders.push({ x: -9.2, z: 3.2, r: 0, hx: 1.05, hz: 1.02, rot: 0.4 });
}

function addPool(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  water: THREE.Material,
  textures: THREE.Texture[],
  colliders: Collider[],
) {
  const pool = new THREE.Group();
  pool.position.set(11, 0, -9);
  const innerW = 4.7;
  const innerD = 2.5;
  const outerW = 7.6;
  const outerD = 5.7;
  const depth = 0.7;
  const deckTex = tileTexture(THREE, textures, "#e8dfcc", "#c9bda6", 6);
  deckTex.repeat.set(2.4, 1.6);
  const deckMat = mat(new THREE.MeshStandardMaterial({ map: deckTex, roughness: 0.8 }));
  const sideW = (outerW - innerW) / 2;
  const sideD = (outerD - innerD) / 2;
  const deckParts = [
    [-(innerW / 2 + sideW / 2), 0, sideW, outerD],
    [innerW / 2 + sideW / 2, 0, sideW, outerD],
    [0, -(innerD / 2 + sideD / 2), innerW, sideD],
    [0, innerD / 2 + sideD / 2, innerW, sideD],
  ] as const;
  for (const [x, z, w, d] of deckParts) {
    const slab = new THREE.Mesh(geo(new THREE.BoxGeometry(w, 0.12, d)), deckMat);
    slab.position.set(x, 0.06, z);
    slab.receiveShadow = true;
    pool.add(slab);
  }

  const mosaicTex = tileTexture(THREE, textures, "#9fdcea", "#5cb3cc", 10);
  mosaicTex.repeat.set(5, 2.6);
  const mosaic = mat(new THREE.MeshStandardMaterial({ map: mosaicTex, roughness: 0.3, envMapIntensity: 0.5 }));
  const floor = new THREE.Mesh(geo(new THREE.BoxGeometry(innerW, 0.04, innerD)), mosaic);
  floor.position.y = -depth + 0.02;
  floor.receiveShadow = true;
  pool.add(floor);
  const wallThick = 0.06;
  const walls = [
    [-(innerW / 2 - wallThick / 2), 0, wallThick, innerD],
    [innerW / 2 - wallThick / 2, 0, wallThick, innerD],
    [0, -(innerD / 2 - wallThick / 2), innerW, wallThick],
    [0, innerD / 2 - wallThick / 2, innerW, wallThick],
  ] as const;
  for (const [x, z, w, d] of walls) {
    const wall = new THREE.Mesh(geo(new THREE.BoxGeometry(w, depth + 0.1, d)), mosaic);
    wall.position.set(x, -depth / 2 + 0.07, z);
    pool.add(wall);
  }
  const laneMat = mat(new THREE.MeshStandardMaterial({ color: 0x1b4f7a, roughness: 0.4 }));
  for (const z of [-0.42, 0.42]) {
    const lane = new THREE.Mesh(geo(new THREE.BoxGeometry(innerW - 0.5, 0.01, 0.1)), laneMat);
    lane.position.set(0, -depth + 0.05, z);
    pool.add(lane);
  }

  const coping = mat(new THREE.MeshStandardMaterial({ color: 0xf2eee4, roughness: 0.5 }));
  const copingParts = [
    [-(innerW / 2 + 0.17), 0, 0.34, innerD + 0.68],
    [innerW / 2 + 0.17, 0, 0.34, innerD + 0.68],
    [0, -(innerD / 2 + 0.17), innerW, 0.34],
    [0, innerD / 2 + 0.17, innerW, 0.34],
  ] as const;
  for (const [x, z, w, d] of copingParts) {
    const rim = new THREE.Mesh(geo(new THREE.BoxGeometry(w, 0.08, d)), coping);
    rim.position.set(x, 0.16, z);
    rim.castShadow = true;
    pool.add(rim);
  }

  const surface = new THREE.Mesh(geo(new THREE.PlaneGeometry(innerW - 0.1, innerD - 0.1, 1, 1)), water);
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.04;
  pool.add(surface);

  const rail = mat(new THREE.MeshStandardMaterial({ color: 0xe3e7ec, metalness: 0.85, roughness: 0.18, envMapIntensity: 1.1 }));
  const ladder = new THREE.Group();
  const poleGeo = geo(new THREE.CylinderGeometry(0.035, 0.035, 1.2, 8));
  const bendGeo = geo(new THREE.TorusGeometry(0.16, 0.035, 8, 12, Math.PI / 2));
  for (const x of [-0.26, 0.26]) {
    const pole = new THREE.Mesh(poleGeo, rail);
    pole.position.set(x, -0.3, 0);
    ladder.add(pole);
    const bend = new THREE.Mesh(bendGeo, rail);
    bend.position.set(x, 0.3, 0.16);
    bend.rotation.y = -Math.PI / 2;
    ladder.add(bend);
    const grip = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.035, 0.035, 0.5, 8)), rail);
    grip.position.set(x, 0.46, 0.32);
    grip.rotation.x = Math.PI / 2;
    ladder.add(grip);
  }
  const rungGeo = geo(new THREE.BoxGeometry(0.52, 0.03, 0.05));
  for (let i = 0; i < 4; i += 1) {
    const rung = new THREE.Mesh(rungGeo, rail);
    rung.position.y = -0.62 + i * 0.22;
    ladder.add(rung);
  }
  ladder.position.set(innerW / 2 - 0.4, 0, innerD / 2 - 0.02);
  pool.add(ladder);

  const loungeFrame = mat(new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.55 }));
  const loungeCloth = mat(new THREE.MeshStandardMaterial({ color: 0x1f8a70, roughness: 0.85 }));
  const lounge = (x: number, z: number, rot: number) => {
    const chair = new THREE.Group();
    const seat = new THREE.Mesh(geo(new THREE.BoxGeometry(0.62, 0.05, 1.25)), loungeCloth);
    seat.position.set(0, 0.36, 0.1);
    seat.castShadow = true;
    const back = new THREE.Mesh(geo(new THREE.BoxGeometry(0.62, 0.05, 0.72)), loungeCloth);
    back.position.set(0, 0.6, -0.78);
    back.rotation.x = -0.95;
    back.castShadow = true;
    chair.add(seat, back);
    const legGeo = geo(new THREE.BoxGeometry(0.05, 0.3, 0.05));
    for (const [lx, lz] of [
      [-0.28, -0.45],
      [0.28, -0.45],
      [-0.28, 0.6],
      [0.28, 0.6],
    ] as const) {
      const leg = new THREE.Mesh(legGeo, loungeFrame);
      leg.position.set(lx, 0.18, lz);
      chair.add(leg);
    }
    chair.position.set(x, 0.12, z);
    chair.rotation.y = rot;
    pool.add(chair);
    colliders.push({ x: 11 + x, z: -9 + z, r: 0.62 });
  };
  lounge(-1.2, 2.05, Math.PI);
  lounge(1.0, 2.05, Math.PI);

  const umbrella = new THREE.Group();
  const pole = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.03, 0.03, 2.3, 8)), rail);
  pole.position.y = 1.15;
  const canopyMat = mat(new THREE.MeshStandardMaterial({ color: 0xf2f0ea, roughness: 0.8, side: THREE.DoubleSide }));
  const stripeMat = mat(new THREE.MeshStandardMaterial({ color: 0x1f8a70, roughness: 0.8, side: THREE.DoubleSide }));
  const canopyGeo = geo(new THREE.ConeGeometry(1.25, 0.42, 8, 1, true));
  const canopy = new THREE.Mesh(canopyGeo, canopyMat);
  canopy.position.y = 2.1;
  canopy.castShadow = true;
  const stripes = new THREE.Mesh(geo(new THREE.ConeGeometry(1.255, 0.42, 8, 1, true, 0, Math.PI / 4)), stripeMat);
  stripes.position.y = 2.1;
  const stripes2 = stripes.clone();
  stripes2.rotation.y = Math.PI / 2;
  const stripes3 = stripes.clone();
  stripes3.rotation.y = Math.PI;
  const stripes4 = stripes.clone();
  stripes4.rotation.y = -Math.PI / 2;
  umbrella.add(pole, canopy, stripes, stripes2, stripes3, stripes4);
  umbrella.position.set(-0.1, 0.12, 2.25);
  pool.add(umbrella);
  colliders.push({ x: 10.9, z: -6.75, r: 0.2 });

  scene.add(pool);
  colliders.push({ x: 11, z: -9, r: 0, hx: innerW / 2 + 0.34, hz: innerD / 2 + 0.34 });
}

function addIceCream(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  wood: THREE.Material,
  textures: THREE.Texture[],
  colliders: Collider[],
) {
  const stand = new THREE.Group();
  stand.position.set(-3.1, 0, 11.8);
  stand.rotation.y = 0.5;
  const counter = new THREE.Mesh(geo(new THREE.BoxGeometry(2.2, 1.05, 0.85)), wood);
  counter.position.y = 0.52;
  counter.castShadow = true;
  const top = mat(new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.55 }));
  const slab = new THREE.Mesh(geo(new THREE.BoxGeometry(2.3, 0.08, 0.95)), top);
  slab.position.y = 1.08;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 160;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f25f8a";
    ctx.fillRect(0, 0, 512, 160);
    ctx.fillStyle = "#fff8ef";
    ctx.font = "700 64px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("ICE CREAM", 256, 82);
  }
  const signTexture = new THREE.CanvasTexture(canvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(signTexture);
  const signMat = mat(new THREE.MeshStandardMaterial({ map: signTexture }));
  const sign = new THREE.Mesh(geo(new THREE.BoxGeometry(1.7, 0.42, 0.06)), signMat);
  sign.position.set(0, 1.85, 0.1);
  const awning = mat(new THREE.MeshStandardMaterial({ color: 0xf7f1e4, roughness: 0.7 }));
  const stripe = mat(new THREE.MeshStandardMaterial({ color: 0xe25b78, roughness: 0.7 }));
  for (let i = 0; i < 6; i += 1) {
    const panel = new THREE.Mesh(geo(new THREE.BoxGeometry(0.36, 0.08, 1.15)), i % 2 === 0 ? stripe : awning);
    panel.position.set(-0.9 + i * 0.36, 2.15, 0.15);
    stand.add(panel);
  }
  const flavors = [0xf6e7c1, 0x6b3a24, 0xf25f8a];
  flavors.forEach((color, index) => {
    const scoop = new THREE.Mesh(
      geo(new THREE.SphereGeometry(0.11, 10, 8)),
      mat(new THREE.MeshStandardMaterial({ color, roughness: 0.45 })),
    );
    scoop.position.set(-0.45 + index * 0.28, 1.28, 0.28);
    stand.add(scoop);
  });
  stand.add(counter, slab, sign);
  scene.add(stand);
  colliders.push({ x: -3.1, z: 11.8, r: 1.15 });
}

function addPingPong(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  colliders: Collider[],
) {
  const table = new THREE.Group();
  const x = -6.6;
  const z = 8.6;
  table.position.set(x, 0, z);
  table.rotation.y = 0.3;
  const green = mat(new THREE.MeshStandardMaterial({ color: 0x1f8a4c, roughness: 0.55 }));
  const white = mat(new THREE.MeshStandardMaterial({ color: 0xf4f7f2, roughness: 0.4 }));
  const top = new THREE.Mesh(geo(new THREE.BoxGeometry(2.55, 0.06, 1.35)), green);
  top.position.y = 0.76;
  top.castShadow = true;
  const line = new THREE.Mesh(geo(new THREE.BoxGeometry(0.03, 0.01, 1.35)), white);
  line.position.y = 0.8;
  const net = new THREE.Mesh(
    geo(new THREE.BoxGeometry(0.02, 0.16, 1.4)),
    mat(new THREE.MeshStandardMaterial({ color: 0xf7f7f7, transparent: true, opacity: 0.85 })),
  );
  net.position.y = 0.9;
  const legGeo = geo(new THREE.BoxGeometry(0.06, 0.74, 0.06));
  const metal = mat(new THREE.MeshStandardMaterial({ color: 0x56616c, metalness: 0.4, roughness: 0.4 }));
  for (const [lx, lz] of [
    [-1.05, -0.48],
    [1.05, -0.48],
    [-1.05, 0.48],
    [1.05, 0.48],
  ] as const) {
    const leg = new THREE.Mesh(legGeo, metal);
    leg.position.set(lx, 0.37, lz);
    table.add(leg);
  }
  table.add(top, line, net);
  scene.add(table);
  colliders.push({ x, z, r: 0, hx: 1.35, hz: 0.8, rot: 0.3 });
  const cos = Math.cos(0.3);
  const sin = Math.sin(0.3);
  const end = (localX: number) => ({ x: x + localX * cos, z: z + localX * sin });
  const ball = new THREE.Mesh(
    geo(new THREE.SphereGeometry(0.04, 10, 8)),
    mat(new THREE.MeshStandardMaterial({ color: 0xfff4d2, roughness: 0.35 })),
  );
  ball.castShadow = true;
  scene.add(ball);
  return { ball, from: end(-1.05), to: end(1.05), ends: [end(-1.55), end(1.55)] as const, facing: 0.3 };
}

function addCards(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
) {
  const cards = new THREE.Group();
  cards.position.set(-9.2, 0.78, 3.2);
  cards.rotation.y = 0.4;
  const colors = [0xf7f4ea, 0xf7f4ea, 0xd4543c, 0x2a3d8f];
  colors.forEach((color, index) => {
    const card = new THREE.Mesh(
      geo(new THREE.BoxGeometry(0.12, 0.01, 0.18)),
      mat(new THREE.MeshStandardMaterial({ color, roughness: 0.6 })),
    );
    card.position.set(-0.18 + (index % 2) * 0.22, 0, -0.08 + Math.floor(index / 2) * 0.16);
    card.rotation.y = index * 0.2;
    cards.add(card);
  });
  scene.add(cards);
}

function addHammock(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  textures: THREE.Texture[],
) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let x = 0; x < 128; x += 16) {
      ctx.fillStyle = x % 32 === 0 ? "#f25f5c" : "#ffe8c2";
      ctx.fillRect(x, 0, 16, 64);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  textures.push(texture);
  const clothMat = mat(
    new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide }),
  );
  const shape = new THREE.Shape();
  shape.moveTo(-1.15, 0.15);
  shape.quadraticCurveTo(0, -0.45, 1.15, 0.15);
  shape.lineTo(1.15, 0.02);
  shape.quadraticCurveTo(0, -0.58, -1.15, 0.02);
  const cloth = new THREE.Mesh(
    geo(new THREE.ExtrudeGeometry(shape, { depth: 0.7, bevelEnabled: false })),
    clothMat,
  );
  cloth.position.set(-5.35, 1.05, -7.7);
  cloth.castShadow = true;
  scene.add(cloth);
}

function addTrees(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  trunkMat: THREE.Material,
  leafMats: THREE.Material[],
  idlers: Idle[],
  colliders: Collider[],
) {
  const spots: Array<[number, number, number]> = [
    [-4.1, -7.4, 1.15],
    [-6.5, -7.2, 1.05],
    [-14, -2, 1.3],
    [-13.2, 6.5, 1.15],
    [-8, 12.4, 1.25],
    [6.5, 13.2, 1.1],
    [13.5, 8, 1.35],
    [14.2, -8.5, 1.2],
    [6, -12.5, 1.15],
    [-2, -13.4, 1.3],
    [-11, -10, 0.95],
    [11.5, 2.5, 1.05],
    [-15.2, 1.5, 1.2],
    [2.5, -14.2, 1],
    [15, 1, 0.9],
    [-5.4, 15.1, 1.1],
  ];
  const trunkGeo = geo(new THREE.CylinderGeometry(0.12, 0.18, 1.15, 6));
  const canopyGeo = geo(new THREE.IcosahedronGeometry(0.95, 1));
  const puffGeo = geo(new THREE.IcosahedronGeometry(0.62, 0));

  for (const [x, z, scale] of spots) {
    if (Math.hypot(x, z) > 16.4) continue;
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.58;
    trunk.castShadow = true;
    const canopy = new THREE.Mesh(canopyGeo, leafMats[(x * 3 + z) & 3]);
    canopy.position.y = 1.65;
    canopy.castShadow = true;
    const puff = new THREE.Mesh(puffGeo, leafMats[(x + z * 2) & 3]);
    puff.position.set(0.35, 1.35, 0.2);
    puff.castShadow = true;
    const shade = new THREE.Mesh(puffGeo, leafMats[1]);
    shade.position.set(-0.15, 1.15, -0.1);
    shade.scale.setScalar(0.85);
    tree.add(trunk, shade, canopy, puff);
    tree.scale.setScalar(scale);
    tree.position.set(x, 0, z);
    scene.add(tree);
    idlers.push({ object: tree, base: 0, phase: x + z, sway: canopy });
    colliders.push({ x, z, r: 0.42 * scale });
  }
}

function addFlowers(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  mobile: boolean,
) {
  const colors = [0xf25f8a, 0xf6e27a, 0xfff6ea, 0xc98adf, 0xff8c42, 0xe85d4c, 0xf2b6c6];
  const petalGeo = geo(new THREE.SphereGeometry(0.055, 8, 6));
  const centerGeo = geo(new THREE.SphereGeometry(0.032, 8, 6));
  const stemGeo = geo(new THREE.CylinderGeometry(0.012, 0.016, 0.34, 5));
  const leafGeo = geo(new THREE.SphereGeometry(0.04, 6, 4));
  const stemMat = mat(new THREE.MeshStandardMaterial({ color: 0x2f7a38, roughness: 0.85 }));
  const centerMat = mat(new THREE.MeshStandardMaterial({ color: 0xf0b429, roughness: 0.55 }));
  const petalMats = colors.map((color) =>
    mat(new THREE.MeshStandardMaterial({ color, roughness: 0.48, emissive: color, emissiveIntensity: 0.05 })),
  );
  const beds = [
    [3.35, 13.55],
    [1.15, 14.85],
    [-12.5, -4],
    [4.5, -9.5],
    [-6.4, 8.8],
    [12.2, 6.4],
  ];
  const flowersPerBed = mobile ? 4 : 6;
  // Every flower is 8 meshes; ~50 flowers would be 400 draw calls per pass.
  // Collect world matrices and draw them as a handful of instanced meshes.
  const stems: THREE.Matrix4[] = [];
  const leaves: THREE.Matrix4[] = [];
  const centers: THREE.Matrix4[] = [];
  const petals: THREE.Matrix4[][] = colors.map(() => []);
  const plant = (x: number, z: number, index: number, scale: number) => {
    const flower = new THREE.Group();
    const stem = new THREE.Object3D();
    stem.position.y = 0.16;
    stem.rotation.z = (seeded(index + 4) - 0.5) * 0.25;
    const leaf = new THREE.Object3D();
    leaf.scale.set(1.5, 0.35, 0.7);
    leaf.position.set(0.05, 0.1, 0);
    leaf.rotation.z = 0.8;
    const petalIndex = ((index % petalMats.length) + petalMats.length) % petalMats.length;
    const petalNodes: THREE.Object3D[] = [];
    for (let petal = 0; petal < 5; petal += 1) {
      const node = new THREE.Object3D();
      const angle = (petal / 5) * Math.PI * 2 + index;
      node.scale.set(0.85, 0.38, 1.55);
      node.position.set(Math.cos(angle) * 0.055, 0.34, Math.sin(angle) * 0.055);
      node.rotation.y = -angle;
      node.rotation.x = 0.55;
      flower.add(node);
      petalNodes.push(node);
    }
    const center = new THREE.Object3D();
    center.position.y = 0.35;
    flower.add(stem, leaf, center);
    flower.position.set(x, 0, z);
    flower.scale.setScalar(scale);
    flower.rotation.y = seeded(index + 12) * Math.PI * 2;
    flower.updateMatrixWorld(true);
    stems.push(stem.matrixWorld.clone());
    leaves.push(leaf.matrixWorld.clone());
    centers.push(center.matrixWorld.clone());
    for (const node of petalNodes) petals[petalIndex].push(node.matrixWorld.clone());
  };
  const bake = (geometry: THREE.BufferGeometry, material: THREE.Material, matrices: THREE.Matrix4[], shadow: boolean) => {
    if (matrices.length === 0) return;
    const mesh = new THREE.InstancedMesh(geometry, material, matrices.length);
    matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = shadow;
    scene.add(mesh);
  };
  for (const [bx, bz] of beds) {
    for (let i = 0; i < flowersPerBed; i += 1) {
      const angle = (i / flowersPerBed) * Math.PI * 2;
      const radius = 0.28 + seeded(i + bx) * 0.28;
      plant(bx + Math.cos(angle) * radius, bz + Math.sin(angle) * radius, i + Math.round(bx * 10), 0.85 + seeded(i + bz) * 0.45);
    }
  }
  const wild = mobile ? 8 : 16;
  for (let i = 0; i < wild; i += 1) {
    const angle = seeded(i + 30) * Math.PI * 2;
    const radius = 3.2 + seeded(i + 44) * 12;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const onRing = radius > 6.5 && radius < 9.7;
    const onEntrance = Math.abs(x) < 1.5 && z > 7.4;
    if (onRing || onEntrance || Math.hypot(x - 10.2, z + 2.2) < 3.3) continue;
    plant(x, z, i + 80, 0.7 + seeded(i + 2) * 0.35);
  }
  bake(stemGeo, stemMat, stems, true);
  bake(leafGeo, stemMat, leaves, false);
  bake(centerGeo, centerMat, centers, false);
  petals.forEach((matrices, index) => bake(petalGeo, petalMats[index], matrices, true));
}

function groundTexture(
  THREE: typeof import("three"),
  textures: THREE.Texture[],
  base: string,
  speck: string,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  if (ctx) {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2400; i += 1) {
      const n = seeded(i + base.length);
      ctx.fillStyle = i % 3 === 0 ? speck : n > 0.7 ? "rgba(255,248,230,0.18)" : "rgba(90,70,40,0.12)";
      ctx.fillRect(n * 512, seeded(i + 5) * 512, 1 + (i % 3), 1 + (i % 2));
    }
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.anisotropy = 8;
  textures.push(texture);
  return texture;
}

function waterMaterial(
  THREE: typeof import("three"),
  options: { shallow: string; deep: string; alpha: number },
) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uShallow: { value: new THREE.Color(options.shallow) },
      uDeep: { value: new THREE.Color(options.deep) },
      uSky: { value: new THREE.Color("#dff1fb") },
      uAlpha: { value: options.alpha },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      void main() {
        vUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      uniform float uTime;
      uniform float uAlpha;
      uniform vec3 uShallow;
      uniform vec3 uDeep;
      uniform vec3 uSky;
      void main() {
        vec2 p = vWorld.xz;
        float wave = sin(p.x * 3.1 + uTime * 1.15) * sin(p.y * 2.4 - uTime * 0.8);
        float ripple = sin((p.x + p.y) * 5.5 + uTime * 1.9) * 0.5 + 0.5;
        float caustic = pow(abs(sin(p.x * 6.3 + uTime * 0.9) * sin(p.y * 5.1 - uTime * 0.7)), 5.0);
        float spark = pow(max(sin(p.x * 17.0 + uTime * 2.2) * sin(p.y * 13.0 - uTime), 0.0), 10.0);
        vec3 viewDir = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - max(dot(viewDir, vNormalW), 0.0), 2.6);
        vec3 color = mix(uDeep, uShallow, 0.42 + wave * 0.18 + ripple * 0.12);
        color += uShallow * caustic * 0.35;
        color = mix(color, uSky, fresnel * 0.65);
        color += vec3(0.9, 0.95, 1.0) * spark * 0.6;
        float alpha = clamp(uAlpha + fresnel * 0.3, 0.0, 1.0);
        gl_FragColor = vec4(color, alpha);
      }
    `,
  });
}

function tileTexture(
  THREE: typeof import("three"),
  textures: THREE.Texture[],
  base: string,
  grout: string,
  tiles: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  if (ctx) {
    ctx.fillStyle = grout;
    ctx.fillRect(0, 0, 512, 512);
    const size = 512 / tiles;
    for (let y = 0; y < tiles; y += 1) {
      for (let x = 0; x < tiles; x += 1) {
        const n = seeded(x * 31 + y * 17 + base.length);
        ctx.fillStyle = base;
        ctx.globalAlpha = 0.82 + n * 0.18;
        ctx.fillRect(x * size + 2, y * size + 2, size - 4, size - 4);
      }
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < 900; i += 1) {
      const n = seeded(i * 3 + tiles);
      ctx.fillStyle = n > 0.5 ? "rgba(255,255,255,0.10)" : "rgba(60,50,40,0.08)";
      ctx.fillRect(seeded(i) * 512, seeded(i + 11) * 512, 2, 2);
    }
  }
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.anisotropy = 8;
  textures.push(texture);
  return texture;
}

function addFence(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  wood: THREE.Material,
) {
  const radius = 17.3;
  const count = 84;
  const step = (Math.PI * 2) / count;
  const segment = 2 * radius * Math.sin(step / 2);
  const keep: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = i * step;
    const midA = a + step / 2;
    const midX = Math.cos(midA) * radius;
    const midZ = Math.sin(midA) * radius;
    if (midZ > 0 && Math.abs(midX) < 2.1) continue;
    keep.push(i);
  }
  const posts = new THREE.InstancedMesh(geo(new THREE.BoxGeometry(0.13, 1.0, 0.13)), wood, count);
  const rails = new THREE.InstancedMesh(geo(new THREE.BoxGeometry(segment, 0.07, 0.05)), wood, keep.length * 2);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i += 1) {
    const a = i * step;
    dummy.position.set(Math.cos(a) * radius, 0.5, Math.sin(a) * radius);
    dummy.rotation.set(0, -a, 0);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
  }
  keep.forEach((i, index) => {
    const midA = i * step + step / 2;
    for (const [slot, y] of [
      [0, 0.52],
      [1, 0.86],
    ] as const) {
      dummy.position.set(Math.cos(midA) * radius, y, Math.sin(midA) * radius);
      dummy.rotation.set(0, -midA - Math.PI / 2, 0);
      dummy.updateMatrix();
      rails.setMatrixAt(index * 2 + slot, dummy.matrix);
    }
  });
  posts.castShadow = true;
  rails.castShadow = true;
  scene.add(posts, rails);
}

function addHorizon(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  mobile: boolean,
) {
  const meadow = new THREE.Mesh(
    geo(new THREE.CircleGeometry(95, 48)),
    mat(new THREE.MeshStandardMaterial({ color: 0x86a86a, roughness: 1 })),
  );
  meadow.rotation.x = -Math.PI / 2;
  meadow.position.y = -0.72;
  scene.add(meadow);

  const hillMats = ["#6f9a6b", "#5f8b67", "#7ca472"].map((color) =>
    mat(new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true })),
  );
  const hillGeo = geo(new THREE.ConeGeometry(1, 1, mobile ? 7 : 9, 1));
  const hills = [
    [0, 58, 16, 9],
    [0.45, 66, 20, 13],
    [0.95, 60, 15, 8],
    [1.5, 70, 24, 15],
    [2.05, 62, 17, 10],
    [2.6, 68, 21, 12],
    [3.15, 60, 15, 9],
    [3.7, 72, 26, 16],
    [4.25, 63, 18, 11],
    [4.8, 67, 20, 12],
    [5.35, 59, 15, 8],
    [5.85, 69, 22, 14],
  ] as const;
  hills.forEach(([angle, dist, radius, height], index) => {
    const hill = new THREE.Mesh(hillGeo, hillMats[index % hillMats.length]);
    hill.position.set(Math.cos(angle) * dist, -0.7, Math.sin(angle) * dist);
    hill.scale.set(radius, height, radius * 0.8);
    hill.rotation.y = angle * 1.7;
    scene.add(hill);
  });

  const farTreeMat = mat(new THREE.MeshStandardMaterial({ color: 0x3d7a46, roughness: 1 }));
  const farTrees = new THREE.InstancedMesh(geo(new THREE.ConeGeometry(1.4, 4.2, 6)), farTreeMat, mobile ? 28 : 56);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < farTrees.count; i += 1) {
    const a = seeded(i * 7 + 3) * Math.PI * 2;
    const d = 24 + seeded(i * 5 + 1) * 20;
    const s = 0.8 + seeded(i * 11 + 2) * 0.9;
    dummy.position.set(Math.cos(a) * d, 2.1 * s - 0.72, Math.sin(a) * d);
    dummy.scale.set(s, s, s);
    dummy.rotation.set(0, a, 0);
    dummy.updateMatrix();
    farTrees.setMatrixAt(i, dummy.matrix);
  }
  scene.add(farTrees);
}

function addSky(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  mat: <T extends THREE.Material>(material: T) => T,
  textures: THREE.Texture[],
  sunDirection: THREE.Vector3,
  mobile: boolean,
) {
  const sunCanvas = document.createElement("canvas");
  sunCanvas.width = 128;
  sunCanvas.height = 128;
  const sunCtx = sunCanvas.getContext("2d");
  if (sunCtx) {
    const glow = sunCtx.createRadialGradient(64, 64, 6, 64, 64, 64);
    glow.addColorStop(0, "rgba(255,252,235,1)");
    glow.addColorStop(0.28, "rgba(255,240,200,0.9)");
    glow.addColorStop(0.6, "rgba(255,225,170,0.25)");
    glow.addColorStop(1, "rgba(255,220,160,0)");
    sunCtx.fillStyle = glow;
    sunCtx.fillRect(0, 0, 128, 128);
  }
  const sunTexture = new THREE.CanvasTexture(sunCanvas);
  sunTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(sunTexture);
  const sunSprite = new THREE.Sprite(
    mat(new THREE.SpriteMaterial({ map: sunTexture, transparent: true, depthWrite: false, fog: false, toneMapped: false })),
  );
  sunSprite.position.copy(sunDirection).normalize().multiplyScalar(88);
  sunSprite.scale.set(26, 26, 1);
  scene.add(sunSprite);

  const cloudCanvas = document.createElement("canvas");
  cloudCanvas.width = 256;
  cloudCanvas.height = 128;
  const cloudCtx = cloudCanvas.getContext("2d");
  if (cloudCtx) {
    const puffs = [
      [70, 78, 42],
      [120, 62, 50],
      [170, 76, 40],
      [100, 88, 34],
      [145, 90, 36],
    ] as const;
    for (const [x, y, r] of puffs) {
      const puff = cloudCtx.createRadialGradient(x, y, r * 0.2, x, y, r);
      puff.addColorStop(0, "rgba(255,255,255,0.95)");
      puff.addColorStop(0.7, "rgba(255,255,255,0.55)");
      puff.addColorStop(1, "rgba(255,255,255,0)");
      cloudCtx.fillStyle = puff;
      cloudCtx.fillRect(0, 0, 256, 128);
    }
  }
  const cloudTexture = new THREE.CanvasTexture(cloudCanvas);
  cloudTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(cloudTexture);
  const cloudMat = mat(
    new THREE.SpriteMaterial({ map: cloudTexture, transparent: true, depthWrite: false, fog: false, toneMapped: false, opacity: 0.92 }),
  );
  const cloudCount = mobile ? 7 : 12;
  for (let i = 0; i < cloudCount; i += 1) {
    const cloud = new THREE.Sprite(cloudMat);
    const a = (i / cloudCount) * Math.PI * 2 + seeded(i + 21) * 0.5;
    const d = 54 + seeded(i + 33) * 24;
    const w = 16 + seeded(i + 45) * 14;
    cloud.position.set(Math.cos(a) * d, 20 + seeded(i + 57) * 14, Math.sin(a) * d);
    cloud.scale.set(w, w * 0.5, 1);
    scene.add(cloud);
  }

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(96, 28, 18),
    mat(
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        uniforms: {
          uTop: { value: new THREE.Color("#6eb6ea") },
          uHorizon: { value: new THREE.Color("#e7f4fb") },
        },
        vertexShader: `
          varying vec3 vPosition;
          void main() {
            vPosition = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          varying vec3 vPosition;
          uniform vec3 uTop;
          uniform vec3 uHorizon;
          void main() {
            float height = clamp(vPosition.y / 50.0 + 0.15, 0.0, 1.0);
            gl_FragColor = vec4(mix(uHorizon, uTop, height), 1.0);
          }
        `,
      }),
    ),
  );
  scene.add(sky);
}

function addTufts(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  textures: THREE.Texture[],
  count: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.push(texture);
  if (ctx) {
    ctx.clearRect(0, 0, 64, 128);
    const drawBlade = (x: number, width: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(x, 124);
      ctx.quadraticCurveTo(x + width * 0.2, 60, x + width * 0.05, 6);
      ctx.quadraticCurveTo(x + width * 0.5, 48, x + width, 124);
      ctx.fill();
    };
    drawBlade(8, 14, "#2f6d32");
    drawBlade(24, 16, "#4e9a45");
    drawBlade(40, 12, "#6aaa4a");
  }
  const green = mat(
    new THREE.MeshStandardMaterial({
      color: 0xb7d98a,
      map: texture,
      transparent: true,
      alphaTest: 0.35,
      side: THREE.DoubleSide,
      roughness: 1,
    }),
  );
  const plane = geo(new THREE.PlaneGeometry(0.34, 0.5, 1, 4));
  const positions = plane.attributes.position;
  for (let i = 0; i < positions.count; i += 1) {
    const y = positions.getY(i);
    positions.setX(i, positions.getX(i) + Math.sin(y * 8) * 0.03);
  }
  plane.computeVertexNormals();
  const blades = new THREE.InstancedMesh(plane, green, count * 2);
  blades.receiveShadow = true;
  const dummy = new THREE.Object3D();
  let written = 0;
  for (let i = 0; i < count; i += 1) {
    const angle = seeded(i + 3) * Math.PI * 2;
    const radius = 2.2 + seeded(i + 19) * 13.5;
    const x = Math.cos(angle) * radius;
    const z = Math.sin(angle) * radius;
    const onRing = radius > 6.6 && radius < 9.6;
    const onEntrance = Math.abs(x) < 1.4 && z > 7.5;
    if (onRing || onEntrance || Math.hypot(x - 10.2, z + 2.2) < 3.4) continue;
    const height = 0.75 + seeded(i + 40) * 0.7;
    for (const turn of [0, Math.PI / 2]) {
      dummy.position.set(x, 0.22 * height, z);
      dummy.rotation.set((seeded(i + 7) - 0.5) * 0.2, angle + turn, (seeded(i + 11) - 0.5) * 0.25);
      dummy.scale.set(0.8 + seeded(i + 5) * 0.5, height, 1);
      dummy.updateMatrix();
      blades.setMatrixAt(written, dummy.matrix);
      written += 1;
    }
  }
  blades.count = written;
  blades.instanceMatrix.needsUpdate = true;
  scene.add(blades);
}

function seeded(n: number) {
  const value = Math.sin(n * 127.1) * 43758.5453;
  return value - Math.floor(value);
}

function clipNamed(clips: THREE.AnimationClip[], name: string) {
  const clip = clips.find((entry) => entry.name === `CharacterArmature|${name}` || entry.name === name);
  if (!clip) throw new Error(`Missing character clip ${name}`);
  return clip;
}

const SKINS = [0xf6d7c3, 0xefc2a4, 0xe0ac84, 0xc68642, 0xa86b3c, 0x8d5524, 0x6f4228, 0x5a3824, 0x3f2918];
const HAIRS = [0x1c1c1c, 0x2b2118, 0x4a3422, 0x6b4428, 0x8d6239, 0xc6a36a, 0x3a2418, 0x111111];
const CLOTHES = [
  [0xd4543c, 0x31425c, 0x241c18],
  [0xf0c14a, 0x3d3428, 0x241c18],
  [0x3d6fd8, 0x2a3142, 0x1a1a1a],
  [0x8d4ec9, 0x2c2438, 0x241c18],
  [0xe07aa8, 0x3a2a32, 0x241c18],
  [0xf4f1ea, 0x31425c, 0x2a211c],
  [0x2f6f4e, 0x1e2a24, 0x1a1a1a],
  [0xe8e4dc, 0x6b3a2a, 0x241c18],
  [0xc65b45, 0x243044, 0x1a1a1a],
  [0x4aa3c7, 0x2a3340, 0x241c18],
  [0xf2a65a, 0x3e3428, 0x2a211c],
  [0x7d4e3b, 0x243044, 0x1a1a1a],
];
const CLOTH_NAMES = new Set(["Red_Dark", "LightBrown", "Red", "Brown", "LimeGreen", "White"]);
const VISITOR_LINES = [
  "Welcome to The Hangout.",
  "The gazebo is the coolest seat in the park.",
  "Have you seen the pond yet?",
  "I come here whenever I need a quiet hour.",
  "Those flowers just opened this morning.",
  "The hammock is free, if you want it.",
  "Evenings here feel like a small holiday.",
  "The grass is soft if you stay off the path.",
];
const POLICE_LINES = [
  "Park security. Enjoy your visit.",
  "We are keeping The Hangout safe.",
  "Stay on the paths and have a good time.",
  "If you need help, just come over.",
  "All quiet on the grounds. Carry on.",
  "Welcome in. We are on watch.",
];

function lookFromCodes(codes: number[]): Look {
  const pick = <T,>(list: T[], index: number | undefined) => list[Math.abs(Math.trunc(index ?? 0)) % list.length];
  return {
    skin: pick(SKINS, codes[0]),
    hair: pick(HAIRS, codes[1]),
    cloth: pick(CLOTHES, codes[2]),
    police: false,
  };
}

function nameTag(
  THREE: typeof import("three"),
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
  text: string,
  groupScale: number,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgba(30,51,40,0.78)";
    ctx.beginPath();
    ctx.roundRect(8, 8, 240, 48, 24);
    ctx.fill();
    ctx.fillStyle = "#f7f1e4";
    ctx.font = "600 26px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text.slice(0, 16), 128, 33);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const inv = 1 / Math.max(groupScale, 0.0001);
  sprite.position.set(0, 1.92 * inv, 0);
  sprite.scale.set(0.68 * inv, 0.17 * inv, 1);
  disposables.add(texture);
  disposables.add(material);
  return sprite;
}

function lookFor(index: number, police: boolean): Look {
  if (police) {
    return {
      skin: SKINS[index % SKINS.length],
      hair: HAIRS[(index + 2) % HAIRS.length],
      cloth: [0x1a2d52, 0x151922, 0x111111],
      police: true,
    };
  }
  return {
    skin: SKINS[index % SKINS.length],
    hair: HAIRS[index % HAIRS.length],
    cloth: CLOTHES[index % CLOTHES.length],
    police: false,
  };
}

function linesFor(role: "visitor" | "police", index: number) {
  const source = role === "police" ? POLICE_LINES : VISITOR_LINES;
  const shift = index % source.length;
  return source.slice(shift).concat(source.slice(0, shift));
}

function clothColor(meshName: string, look: Look) {
  const name = meshName.toLowerCase();
  if (look.police) {
    if (name.includes("leg")) return 0x151922;
    if (name.includes("feet") || name.includes("foot")) return 0x111111;
    return 0x1a2d52;
  }
  if (name.includes("leg")) return look.cloth[1] ?? look.cloth[0];
  if (name.includes("feet") || name.includes("foot")) return look.cloth[2] ?? 0x241c18;
  return look.cloth[0];
}

function styleMaterial(material: THREE.Material, meshName: string, look: Look) {
  const name = material.name || "";
  const next = material.clone() as THREE.MeshStandardMaterial;
  const head = meshName.toLowerCase().includes("head");
  if (name === "Skin" && next.color) {
    next.color.setHex(look.skin);
    next.roughness = 0.84;
    next.metalness = 0;
    next.envMapIntensity = 0;
    next.emissive?.setHex(0x000000);
    next.emissiveIntensity = 0;
  } else if ((name === "Hair" || name === "Eyebrows" || (head && name === "Brown")) && next.color) {
    next.color.setHex(look.hair);
    next.roughness = 0.76;
    next.metalness = 0;
    next.envMapIntensity = 0.08;
    next.emissive?.setHex(0x000000);
    next.emissiveIntensity = 0;
  } else if (CLOTH_NAMES.has(name) && next.color) {
    next.color.setHex(clothColor(meshName, look));
    next.roughness = 0.78;
    next.metalness = 0;
    next.envMapIntensity = 0.16;
    next.emissive?.setHex(0x000000);
    next.emissiveIntensity = 0;
  }
  return next;
}

function attachPoliceGear(
  THREE: typeof import("three"),
  group: THREE.Group,
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
) {
  const navy = new THREE.MeshStandardMaterial({ color: 0x152033, roughness: 0.5 });
  const gold = new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.35, metalness: 0.45 });
  const yellow = new THREE.MeshStandardMaterial({ color: 0xe2b33a, roughness: 0.5 });
  disposables.add(navy);
  disposables.add(gold);
  disposables.add(yellow);
  group.updateMatrixWorld(true);

  const fit = (boneName: string, mesh: THREE.Mesh, y: number, z: number) => {
    const bone = group.getObjectByName(boneName);
    if (!bone) return;
    const scale = new THREE.Vector3();
    bone.getWorldScale(scale);
    const safe = Math.max(scale.x, 0.0001);
    mesh.scale.setScalar(1 / safe);
    mesh.position.y = y / Math.max(scale.y, 0.0001);
    mesh.position.z = z / Math.max(scale.z, 0.0001);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    disposables.add(mesh.geometry);
    bone.add(mesh);
  };

  const cap = new THREE.Group();
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.018, 14), navy);
  brim.scale.set(1.45, 1, 1);
  const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.084, 0.096, 0.07, 12), navy);
  crown.position.y = 0.044;
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.016), gold);
  band.position.set(0, 0.02, 0.09);
  cap.add(brim, crown, band);
  const head = group.getObjectByName("Head");
  if (head) {
    const scale = new THREE.Vector3();
    head.getWorldScale(scale);
    cap.scale.setScalar(1 / Math.max(scale.x, 0.0001));
    cap.position.y = 0.16 / Math.max(scale.y, 0.0001);
    cap.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.frustumCulled = false;
      disposables.add(mesh.geometry);
    });
    head.add(cap);
  }
  fit("Chest", new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.07, 0.012), gold), 0.04, 0.16);
  fit("UpperArmL", new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), yellow), -0.08, 0);
}

function spawnActor(
  THREE: typeof import("three"),
  rig: Rig,
  clone: (source: THREE.Object3D) => THREE.Object3D,
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
  look: Look,
  talk = true,
): Actor {
  const group = clone(rig.scene);
  if (!(group instanceof THREE.Group)) throw new Error("Character rig did not clone to a group");
  group.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    disposables.add(mesh.geometry);
    const source = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const styled = source.map((material) => {
      disposables.add(material);
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) disposables.add(value);
      }
      const next = styleMaterial(material, mesh.name, look);
      disposables.add(next);
      return next;
    });
    mesh.material = styled.length === 1 ? styled[0] : styled;
  });
  group.updateMatrixWorld(true);
  const measured = new THREE.Box3().setFromObject(group);
  const height = measured.max.y - measured.min.y;
  if (height > 0) group.scale.multiplyScalar(1.72 / height);
  group.updateMatrixWorld(true);
  const grounded = new THREE.Box3().setFromObject(group);
  group.position.y -= grounded.min.y;
  if (look.police) attachPoliceGear(THREE, group, disposables);

  let bubble: THREE.Sprite | null = null;
  if (talk) {
    bubble = createBubble(THREE, disposables);
    const inv = 1 / Math.max(group.scale.y, 0.0001);
    bubble.position.set(0, 2.15 * inv, 0);
    bubble.scale.set(1.55 * inv, 0.52 * inv, 1);
    group.add(bubble);
  }

  const mixer = new THREE.AnimationMixer(group);
  const idleClip = clipNamed(rig.animations, "Idle_Neutral");
  const interact = rig.animations.find((clip) => clip.name.endsWith("|Interact") || clip.name === "Interact") ?? idleClip;
  const actions = {
    idle: mixer.clipAction(idleClip),
    walk: mixer.clipAction(clipNamed(rig.animations, "Walk")),
    run: mixer.clipAction(clipNamed(rig.animations, "Run")),
    play: mixer.clipAction(interact),
  };
  actions.play.setLoop(THREE.LoopRepeat, Infinity);
  actions.idle.play();
  const role = look.police ? "police" : "visitor";
  return {
    group,
    mixer,
    actions,
    pose: "idle",
    role,
    lines: linesFor(role, 0),
    line: 0,
    cooldown: 0.6,
    talking: 0,
    bubble,
    facing: 0,
    seated: false,
    voice: 0,
    stagger: 0,
  };
}

function setPose(actor: Actor, pose: Pose) {
  if (actor.pose === pose) return;
  const next = actor.actions[pose];
  const previous = actor.actions[actor.pose];
  next.reset().setEffectiveWeight(1).fadeIn(0.18).play();
  previous.fadeOut(0.18);
  actor.pose = pose;
}

function addResidents(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  rigs: { male: Rig; female: Rig },
  clone: (source: THREE.Object3D) => THREE.Object3D,
  cast: Actor[],
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
  people: Collider[],
  colliders: Collider[],
  stationSeat: { x: number; z: number; facing: number } | null,
) {
  const openLoop = (radius: number, count: number, reverse = false) => {
    const points = [];
    for (let i = 0; i < count; i += 1) {
      const angle = ((reverse ? count - i : i) / count) * Math.PI * 2;
      const cleared = resolveCircle(Math.cos(angle) * radius, Math.sin(angle) * radius, 0.9, colliders);
      const reach = Math.hypot(cleared.x, cleared.z);
      const limit = 15.2;
      points.push(reach > limit ? { x: (cleared.x * limit) / reach, z: (cleared.z * limit) / reach } : cleared);
    }
    return points;
  };
  const visitorRoutes = [
    openLoop(8.15, 16),
    openLoop(8.15, 16, true),
    openLoop(3.85, 10),
    openLoop(10.5, 16),
    openLoop(12.4, 14, true),
    openLoop(7.35, 14),
  ];
  const policeLoop = openLoop(13.8, 16);
  const walkers: Walker[] = [];
  const speakers: Actor[] = [];
  const scooters: Scooter[] = [];

  const placeWalker = (
    route: Array<{ x: number; z: number }>,
    index: number,
    police: boolean,
    rig: Rig,
  ) => {
    const actor = spawnActor(THREE, rig, clone, disposables, lookFor(index + (police ? 4 : 0), police));
    const start = route[index % route.length];
    const next = route[(index + 1) % route.length];
    actor.group.position.set(start.x, actor.group.position.y, start.z);
    actor.facing = Math.atan2(next.x - start.x, next.z - start.z);
    actor.group.rotation.y = actor.facing;
    actor.lines = linesFor(police ? "police" : "visitor", index);
    actor.voice = index + (police ? 3 : 0);
    actor.cooldown = index * 0.4;
    scene.add(actor.group);
    const collider: Collider = { x: start.x, z: start.z, r: 0.46, owner: actor };
    people.push(collider);
    const walker: Walker = {
      ...actor,
      route,
      index: index % route.length,
      speed: police ? 4.4 : 3.8 + (index % 4) * 0.16,
      pause: index * 0.15,
      collider,
      stuck: 0,
      side: index % 2 === 0 ? 1 : -1,
    };
    cast.push(walker);
    speakers.push(walker);
    walkers.push(walker);
  };

  visitorRoutes.forEach((route, index) => {
    placeWalker(route, index, false, index % 2 === 0 ? rigs.male : rigs.female);
  });
  const placeScooter = (index: number, rig: Rig) => {
    const actor = spawnActor(THREE, rig, clone, disposables, lookFor(index + 4, true));
    const hip = actor.group.getObjectByName("Hips");
    const hipPoint = new THREE.Vector3();
    if (hip) hip.getWorldPosition(hipPoint);
    const hipAbove = hip ? hipPoint.y - actor.group.position.y : 0.9;
    const scooter = makeScooter(THREE);
    const start = policeLoop[index % policeLoop.length];
    const next = policeLoop[(index + 1) % policeLoop.length];
    actor.facing = Math.atan2(next.x - start.x, next.z - start.z);
    actor.seated = true;
    actor.lines = linesFor("police", index);
    actor.voice = index + 3;
    actor.group.position.set(0, 0.66 - hipAbove, -0.1);
    actor.group.rotation.y = 0;
    scooter.add(actor.group);
    scooter.position.set(start.x, 0, start.z);
    scooter.rotation.y = actor.facing;
    scene.add(scooter);
    const collider: Collider = { x: start.x, z: start.z, r: 0.78, owner: actor };
    people.push(collider);
    cast.push(actor);
    speakers.push(actor);
    scooters.push({
      group: scooter,
      rider: actor,
      collider,
      route: policeLoop,
      index: index % policeLoop.length,
      speed: 6.2,
      pause: index * 0.12,
      stuck: 0,
      side: index % 2 === 0 ? 1 : -1,
    });
  };
  placeScooter(0, rigs.male);
  placeScooter(7, rigs.female);
  placeScooter(14, rigs.male);

  if (stationSeat) {
    const desk = spawnActor(THREE, rigs.female, clone, disposables, lookFor(9, true));
    desk.group.position.set(stationSeat.x, -0.4, stationSeat.z);
    desk.facing = stationSeat.facing;
    desk.group.rotation.y = stationSeat.facing;
    desk.seated = true;
    desk.lines = ["This is the station. The gold seats are ours.", "Park the scooter and come inside if you need us.", "We watch the paths from here."];
    desk.voice = 15;
    scene.add(desk.group);
    cast.push(desk);
    speakers.push(desk);
    people.push({ x: stationSeat.x, z: stationSeat.z, r: 0.46, owner: desk, fixed: true });
  }

  for (const [index, degrees] of [30, 150, 210, 270].entries()) {
    const angle = (degrees * Math.PI) / 180;
    const actor = spawnActor(THREE, index % 2 === 0 ? rigs.female : rigs.male, clone, disposables, lookFor(index + 6, false));
    const x = Math.cos(angle) * 6.25;
    const z = Math.sin(angle) * 6.25;
    actor.group.position.set(x, actor.group.position.y, z);
    actor.facing = Math.atan2(-x, -z);
    actor.group.rotation.y = actor.facing;
    actor.lines = linesFor("visitor", index + 2);
    actor.voice = index + 8;
    scene.add(actor.group);
    cast.push(actor);
    speakers.push(actor);
    people.push({ x, z, r: 0.42, owner: actor, fixed: true });
  }

  const guard = spawnActor(THREE, rigs.female, clone, disposables, lookFor(2, true));
  guard.group.position.set(2.75, guard.group.position.y, 14.55);
  guard.facing = Math.atan2(-2.75, -1.2);
  guard.group.rotation.y = guard.facing;
  guard.lines = linesFor("police", 3);
  guard.voice = 11;
  scene.add(guard.group);
  cast.push(guard);
  speakers.push(guard);
  people.push({ x: 2.75, z: 14.55, r: 0.46, owner: guard, fixed: true });

  const poolGuard = spawnActor(THREE, rigs.male, clone, disposables, lookFor(5, true));
  poolGuard.group.position.set(8.15, poolGuard.group.position.y, -7.15);
  poolGuard.facing = Math.atan2(11 - 8.15, -9 - -7.15);
  poolGuard.group.rotation.y = poolGuard.facing;
  poolGuard.lines = ["The pool is open. No running on the deck.", "Park security. Enjoy the water.", "Stay at the ladder end if you are just looking."];
  poolGuard.voice = 12;
  scene.add(poolGuard.group);
  cast.push(poolGuard);
  speakers.push(poolGuard);
  people.push({ x: 8.15, z: -7.15, r: 0.46, owner: poolGuard, fixed: true });

  return { walkers, speakers, scooters };
}

function postPeople(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  rigs: { male: Rig; female: Rig },
  clone: (source: THREE.Object3D) => THREE.Object3D,
  cast: Actor[],
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
  people: Collider[],
  speakers: Actor[],
) {
  const spun = (ox: number, oz: number, lx: number, lz: number, rot: number) => ({
    x: ox + lx * Math.cos(rot) - lz * Math.sin(rot),
    z: oz + lx * Math.sin(rot) + lz * Math.cos(rot),
  });
  const place = (
    x: number,
    z: number,
    facing: number,
    lookIndex: number,
    police: boolean,
    rig: Rig,
    lines: string[],
    voice: number,
    seated: boolean,
    play: boolean,
  ) => {
    const actor = spawnActor(THREE, rig, clone, disposables, lookFor(lookIndex, police));
    actor.group.position.set(x, seated ? -0.4 : actor.group.position.y, z);
    actor.facing = facing;
    actor.group.rotation.y = facing;
    actor.lines = lines;
    actor.voice = voice;
    actor.seated = seated;
    if (play) setPose(actor, "play");
    scene.add(actor.group);
    cast.push(actor);
    speakers.push(actor);
    people.push({ x, z, r: 0.42, owner: actor, fixed: true });
  };
  const table = 0.3;
  const faceAcross = Math.PI / 2 - table;
  const near = spun(-6.6, 8.6, -1.9, 0, table);
  const far = spun(-6.6, 8.6, 1.9, 0, table);
  place(near.x, near.z, faceAcross, 1, false, rigs.male, ["Nice serve.", "That one clipped the edge.", "Your point."], 20, false, true);
  place(far.x, far.z, faceAcross + Math.PI, 4, false, rigs.female, ["I can return that.", "Ready when you are.", "Good rally."], 21, false, true);
  const seatA = spun(-9.2, 3.2, 0, -0.82, 0.4);
  const seatB = spun(-9.2, 3.2, 0, 0.82, 0.4);
  place(seatA.x, seatA.z, 0.4, 6, false, rigs.female, ["Your turn.", "I think you are bluffing.", "One more hand."], 22, true, false);
  place(seatB.x, seatB.z, 0.4 + Math.PI, 8, false, rigs.male, ["Pass me a card.", "That was a lucky draw.", "I am keeping this one."], 23, true, false);
  const vendor = spun(-3.1, 11.8, 0, -0.72, 0.5);
  place(
    vendor.x,
    vendor.z,
    0.5,
    3,
    false,
    rigs.female,
    ["Vanilla, chocolate, or strawberry?", "The cone is warm and the scoop is cold.", "Want a second scoop?"],
    24,
    false,
    false,
  );
}

function addPoliceStation(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  wood: THREE.Material,
  metal: THREE.Material,
  textures: THREE.Texture[],
  colliders: Collider[],
) {
  const angle = (207 * Math.PI) / 180;
  const cx = Math.cos(angle) * 10.9;
  const cz = Math.sin(angle) * 10.9;
  const rot = Math.atan2(-Math.cos(angle), -Math.sin(angle));
  const station = new THREE.Group();
  const wall = mat(new THREE.MeshStandardMaterial({ color: 0xe9ecf1, roughness: 0.82 }));
  const navy = mat(new THREE.MeshStandardMaterial({ color: 0x1a2d52, roughness: 0.7 }));
  const gold = mat(new THREE.MeshStandardMaterial({ color: 0xd4a017, roughness: 0.35, metalness: 0.5 }));
  const glass = mat(new THREE.MeshStandardMaterial({ color: 0x9fd1ec, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.55 }));

  const floor = new THREE.Mesh(geo(new THREE.BoxGeometry(4.6, 0.12, 3.4)), navy);
  floor.position.y = 0.06;
  floor.receiveShadow = true;
  station.add(floor);
  const back = new THREE.Mesh(geo(new THREE.BoxGeometry(4.6, 2.3, 0.14)), wall);
  back.position.set(0, 1.21, -1.63);
  back.castShadow = true;
  station.add(back);
  for (const x of [-2.23, 2.23]) {
    const sideWall = new THREE.Mesh(geo(new THREE.BoxGeometry(0.14, 2.3, 3.4)), wall);
    sideWall.position.set(x, 1.21, 0);
    sideWall.castShadow = true;
    station.add(sideWall);
  }
  const front = new THREE.Mesh(geo(new THREE.BoxGeometry(1.4, 2.3, 0.14)), wall);
  front.position.set(-1.6, 1.21, 1.63);
  station.add(front);
  const pane = new THREE.Mesh(geo(new THREE.BoxGeometry(1.9, 1.1, 0.06)), glass);
  pane.position.set(0.95, 1.35, 1.66);
  station.add(pane);
  const roofSlab = new THREE.Mesh(geo(new THREE.BoxGeometry(5, 0.18, 3.8)), navy);
  roofSlab.position.y = 2.42;
  roofSlab.castShadow = true;
  station.add(roofSlab);

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#1a2d52";
    ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = "#f6e27a";
    ctx.font = "700 64px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PARK POLICE", 256, 66);
  }
  const signTexture = new THREE.CanvasTexture(canvas);
  signTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(signTexture);
  const sign = new THREE.Mesh(geo(new THREE.BoxGeometry(3.2, 0.7, 0.08)), [
    navy,
    navy,
    navy,
    navy,
    mat(new THREE.MeshStandardMaterial({ map: signTexture })),
    navy,
  ]);
  sign.position.set(0, 2.9, 1.7);
  station.add(sign);

  const desk = new THREE.Mesh(geo(new THREE.BoxGeometry(2, 0.08, 0.7)), wood);
  desk.position.set(0.4, 0.86, -0.4);
  desk.castShadow = true;
  station.add(desk);
  for (const [x, z] of [
    [-0.5, -0.7],
    [1.3, -0.7],
    [-0.5, -0.1],
    [1.3, -0.1],
  ] as const) {
    const leg = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, 0.74, 0.06)), metal);
    leg.position.set(x, 0.43, z);
    station.add(leg);
  }

  const seats: Array<{ x: number; z: number; nearX: number; nearZ: number; facing: number }> = [];
  const seatGeo = geo(new THREE.BoxGeometry(0.6, 0.08, 0.5));
  const backGeo = geo(new THREE.BoxGeometry(0.6, 0.5, 0.08));
  const seatSpots: Array<[number, number, number]> = [
    [0.4, -1.1, 0],
    [-1.4, 0.7, Math.PI / 2],
    [1.6, 0.7, -Math.PI / 2],
  ];
  for (const [lx, lz, turn] of seatSpots) {
    const chair = new THREE.Group();
    const cushion = new THREE.Mesh(seatGeo, gold);
    cushion.position.y = 0.5;
    cushion.castShadow = true;
    const rest = new THREE.Mesh(backGeo, gold);
    rest.position.set(0, 0.8, -0.21);
    chair.add(cushion, rest);
    for (const [x, z] of [
      [-0.24, 0.18],
      [0.24, 0.18],
      [-0.24, -0.18],
      [0.24, -0.18],
    ] as const) {
      const leg = new THREE.Mesh(geo(new THREE.BoxGeometry(0.05, 0.5, 0.05)), metal);
      leg.position.set(x, 0.25, z);
      chair.add(leg);
    }
    chair.position.set(lx, 0.12, lz);
    chair.rotation.y = turn;
    station.add(chair);
  }

  station.position.set(cx, 0, cz);
  station.rotation.y = rot;
  station.updateMatrixWorld(true);
  scene.add(station);

  const worldPoint = (lx: number, lz: number) => new THREE.Vector3(lx, 0, lz).applyMatrix4(station.matrixWorld);
  const toWorldRot = (turn: number) => rot + turn;
  colliders.push({ x: worldPoint(0, -1.63).x, z: worldPoint(0, -1.63).z, r: 0, hx: 2.3, hz: 0.1, rot });
  colliders.push({ x: worldPoint(-2.23, 0).x, z: worldPoint(-2.23, 0).z, r: 0, hx: 0.1, hz: 1.7, rot });
  colliders.push({ x: worldPoint(2.23, 0).x, z: worldPoint(2.23, 0).z, r: 0, hx: 0.1, hz: 1.7, rot });
  colliders.push({ x: worldPoint(-1.6, 1.63).x, z: worldPoint(-1.6, 1.63).z, r: 0, hx: 0.7, hz: 0.1, rot });
  colliders.push({ x: worldPoint(0.4, -0.4).x, z: worldPoint(0.4, -0.4).z, r: 0, hx: 1, hz: 0.35, rot });
  for (const [lx, lz, turn] of seatSpots) {
    const seat = worldPoint(lx, lz);
    const outward = new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), toWorldRot(turn));
    colliders.push({ x: seat.x, z: seat.z, r: 0, hx: 0.32, hz: 0.28, rot: toWorldRot(turn) });
    seats.push({ x: seat.x, z: seat.z, nearX: seat.x, nearZ: seat.z, facing: Math.atan2(outward.x, outward.z) });
  }
  const footprint: Collider = { x: cx, z: cz, r: 0, hx: 2.5, hz: 1.9, rot };
  return { seats, footprint };
}

type Pickup = {
  kind: "cash" | "gun" | "flower" | "shades";
  amount: number;
  x: number;
  z: number;
  mesh: THREE.Object3D;
  taken: boolean;
};

function addLoot(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  textures: THREE.Texture[],
) {
  const pickups: Pickup[] = [];
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#6fae6d";
    ctx.fillRect(0, 0, 256, 128);
    ctx.strokeStyle = "#2f5a34";
    ctx.lineWidth = 8;
    ctx.strokeRect(10, 10, 236, 108);
    ctx.fillStyle = "#1e3328";
    ctx.font = "700 72px Georgia, serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("$", 128, 68);
  }
  const billTexture = new THREE.CanvasTexture(canvas);
  billTexture.colorSpace = THREE.SRGBColorSpace;
  textures.push(billTexture);
  const bill = mat(new THREE.MeshStandardMaterial({ map: billTexture, roughness: 0.8 }));
  const gunMetal = mat(new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.35, metalness: 0.7 }));
  const billGeo = geo(new THREE.BoxGeometry(0.42, 0.03, 0.2));
  const barrelGeo = geo(new THREE.BoxGeometry(0.34, 0.08, 0.06));
  const gripGeo = geo(new THREE.BoxGeometry(0.08, 0.2, 0.06));

  const cashSpots: Array<[number, number, number]> = [
    [4.9, 6.4, 20],
    [-7.9, -4.6, 35],
    [1.2, -9.1, 50],
    [12.8, 4.2, 25],
    [-9.6, 9.4, 40],
    [6.3, -3.6, 30],
  ];
  for (const [x, z, amount] of cashSpots) {
    const mesh = new THREE.Mesh(billGeo, bill);
    mesh.position.set(x, 0.42, z);
    mesh.rotation.y = x + z;
    mesh.castShadow = true;
    scene.add(mesh);
    pickups.push({ kind: "cash", amount, x, z, mesh, taken: false });
  }
  const gunSpots: Array<[number, number]> = [
    [-3.4, -11.2],
    [14.1, -3.8],
  ];
  for (const [x, z] of gunSpots) {
    const gun = new THREE.Group();
    const barrel = new THREE.Mesh(barrelGeo, gunMetal);
    const grip = new THREE.Mesh(gripGeo, gunMetal);
    grip.position.set(-0.1, -0.12, 0);
    grip.rotation.z = 0.25;
    barrel.castShadow = true;
    gun.add(barrel, grip);
    gun.position.set(x, 0.42, z);
    gun.rotation.y = x * 0.7;
    scene.add(gun);
    pickups.push({ kind: "gun", amount: 0, x, z, mesh: gun, taken: false });
  }
  const stem = mat(new THREE.MeshStandardMaterial({ color: 0x3f8f3d, roughness: 0.7 }));
  const petal = mat(new THREE.MeshStandardMaterial({ color: 0xe56b8a, roughness: 0.5 }));
  const stemGeo = geo(new THREE.CylinderGeometry(0.02, 0.03, 0.28, 5));
  const bloomGeo = geo(new THREE.SphereGeometry(0.08, 8, 6));
  for (const [x, z] of [
    [3.35, 13.55],
    [-12.5, -4],
    [12.2, 6.4],
  ] as Array<[number, number]>) {
    const flower = new THREE.Group();
    const stalk = new THREE.Mesh(stemGeo, stem);
    stalk.position.y = 0.14;
    const bloom = new THREE.Mesh(bloomGeo, petal);
    bloom.position.y = 0.3;
    flower.add(stalk, bloom);
    flower.position.set(x, 0.12, z);
    flower.castShadow = true;
    scene.add(flower);
    pickups.push({ kind: "flower", amount: 0, x, z, mesh: flower, taken: false });
  }
  const frame = mat(new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.35, metalness: 0.4 }));
  const lens = mat(new THREE.MeshStandardMaterial({ color: 0x1a2430, roughness: 0.15, metalness: 0.2 }));
  for (const [x, z] of [[-5.2, 12.4], [8.6, -6.1]] as Array<[number, number]>) {
    const shades = new THREE.Group();
    const left = new THREE.Mesh(geo(new THREE.BoxGeometry(0.12, 0.06, 0.02)), lens);
    const right = new THREE.Mesh(geo(new THREE.BoxGeometry(0.12, 0.06, 0.02)), lens);
    const bridge = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, 0.02, 0.02)), frame);
    left.position.x = -0.09;
    right.position.x = 0.09;
    shades.add(left, right, bridge);
    shades.position.set(x, 0.42, z);
    shades.rotation.y = x;
    scene.add(shades);
    pickups.push({ kind: "shades", amount: 0, x, z, mesh: shades, taken: false });
  }
  return pickups;
}

function makeScooter(THREE: typeof import("three")) {
  const body = new THREE.MeshStandardMaterial({ color: 0x1a2d52, roughness: 0.5, metalness: 0.2 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xb9c2cc, roughness: 0.3, metalness: 0.7 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const scooter = new THREE.Group();
  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.1, 1.3), body);
  deck.position.y = 0.26;
  deck.castShadow = true;
  const seatPost = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.26, 8), chrome);
  seatPost.position.set(0, 0.42, -0.1);
  const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.08, 0.36), rubber);
  saddle.position.set(0, 0.58, -0.1);
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.85, 8), chrome);
  column.position.set(0, 0.68, 0.62);
  column.rotation.x = -0.18;
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.56, 8), chrome);
  bars.rotation.z = Math.PI / 2;
  bars.position.set(0, 1.08, 0.7);
  const wheelGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.08, 14);
  const frontWheel = new THREE.Mesh(wheelGeo, rubber);
  frontWheel.rotation.z = Math.PI / 2;
  frontWheel.position.set(0, 0.17, 0.66);
  const rearWheel = new THREE.Mesh(wheelGeo, rubber);
  rearWheel.rotation.z = Math.PI / 2;
  rearWheel.position.set(0, 0.17, -0.58);
  const light = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.08, 0.08),
    new THREE.MeshStandardMaterial({ color: 0x4aa3ff, emissive: 0x2d7fe0, emissiveIntensity: 0.9 }),
  );
  light.position.set(0, 1.0, 0.78);
  scooter.add(deck, seatPost, saddle, column, bars, frontWheel, rearWheel, light);
  scooter.userData.wheels = [frontWheel, rearWheel];
  return scooter;
}

function stepScooter(scooter: Scooter, delta: number, world: Collider[], people: Collider[]) {
  const rider = scooter.rider;
  if (rider.stagger > 0) {
    rider.stagger -= delta;
    return;
  }
  if (scooter.pause > 0) {
    scooter.pause -= delta;
    return;
  }
  const target = scooter.route[scooter.index];
  const x = scooter.collider.x;
  const z = scooter.collider.z;
  if (Math.hypot(target.x - x, target.z - z) < 0.9) {
    scooter.index = (scooter.index + 1) % scooter.route.length;
    scooter.stuck = 0;
    return;
  }
  const aim = crowdAim(x, z, target.x, target.z, scooter.collider, people);
  const dx = aim.x - x;
  const dz = aim.z - z;
  const distance = Math.hypot(dx, dz) || 1;
  const step = Math.min(scooter.speed * delta, distance);
  const next = steer(x, z, x + (dx / distance) * step, z + (dz / distance) * step, scooter.collider.r, world, people, scooter.collider, scooter.side);
  scooter.side = next.side;
  const moved = Math.hypot(next.x - x, next.z - z);
  scooter.collider.x = next.x;
  scooter.collider.z = next.z;
  if (moved < step * 0.35) {
    scooter.stuck += delta;
    if (scooter.stuck > 0.6) {
      scooter.side *= -1;
      scooter.stuck = 0;
    }
  } else {
    scooter.stuck = Math.max(0, scooter.stuck - delta * 2);
  }
  const desired = Math.atan2(dx, dz);
  const diff = Math.atan2(Math.sin(desired - rider.facing), Math.cos(desired - rider.facing));
  rider.facing += diff * (1 - Math.exp(-6 * delta));
}

function actorSpot(actor: Actor) {
  const parent = actor.group.parent;
  if (!parent || (parent as THREE.Scene).isScene) return actor.group.position;
  return actor.group.getWorldPosition(actor.group.position.clone());
}

function updateQuests(
  done: Record<string, boolean>,
  player: { x: number; z: number },
  sitting: boolean,
  speakers: Actor[],
  onComplete: (title: string) => void,
) {
  const within = (x: number, z: number, range: number) => Math.hypot(player.x - x, player.z - z) <= range;
  const finish = (id: string, ready: boolean) => {
    if (!ready || done[id]) return;
    done[id] = true;
    const quest = QUEST_LIST.find((entry) => entry.id === id);
    if (quest) onComplete(quest.title);
  };
  finish("gazebo", Math.hypot(player.x, player.z) <= 3.2);
  finish("seat", sitting);
  finish("pond", within(10.2, -2.2, 4.2));
  finish("cream", within(-3.1, 11.8, 2.6));
  finish("rally", within(-6.6, 8.6, 3.4));
  finish("pool", within(11, -9, 5));
  finish(
    "guard",
    speakers.some((speaker) => {
      if (speaker.role !== "police") return false;
      const spot = actorSpot(speaker);
      return within(spot.x, spot.z, 2.3);
    }),
  );
}

function turnToward(walker: Walker, x: number, z: number, delta: number, sharp: number) {
  const desired = Math.atan2(x - walker.group.position.x, z - walker.group.position.z);
  const diff = Math.atan2(Math.sin(desired - walker.facing), Math.cos(desired - walker.facing));
  walker.facing += diff * (1 - Math.exp(-sharp * delta));
  walker.group.rotation.y = walker.facing;
}

function stepWalker(
  walker: Walker,
  delta: number,
  player: THREE.Vector3,
  world: Collider[],
  people: Collider[],
) {
  walker.actions.walk.setEffectiveTimeScale(1.7);
  if (walker.stagger > 0) {
    walker.stagger -= delta;
    setPose(walker, "idle");
    walker.collider.x = walker.group.position.x;
    walker.collider.z = walker.group.position.z;
    return;
  }
  if (walker.pause > 0) {
    walker.pause -= delta;
    setPose(walker, "idle");
    if (Math.hypot(player.x - walker.group.position.x, player.z - walker.group.position.z) < 2.2) {
      turnToward(walker, player.x, player.z, delta, 5);
    }
    walker.collider.x = walker.group.position.x;
    walker.collider.z = walker.group.position.z;
    return;
  }
  const target = walker.route[walker.index];
  const aim = crowdAim(walker.group.position.x, walker.group.position.z, target.x, target.z, walker.collider, people);
  const aimX = aim.x;
  const aimZ = aim.z;
  const dx = aimX - walker.group.position.x;
  const dz = aimZ - walker.group.position.z;
  const distance = Math.hypot(dx, dz);
  if (Math.hypot(target.x - walker.group.position.x, target.z - walker.group.position.z) < 0.6) {
    walker.index = (walker.index + 1) % walker.route.length;
    walker.pause = 0.08;
    walker.stuck = 0;
    return;
  }
  const step = Math.min(walker.speed * delta, Math.max(distance, 0.001));
  const next = steer(
    walker.group.position.x,
    walker.group.position.z,
    walker.group.position.x + (dx / (distance || 1)) * step,
    walker.group.position.z + (dz / (distance || 1)) * step,
    walker.collider.r,
    world,
    people,
    walker.collider,
    walker.side,
  );
  walker.side = next.side;
  const moved = Math.hypot(next.x - walker.group.position.x, next.z - walker.group.position.z);
  walker.group.position.x = next.x;
  walker.group.position.z = next.z;
  walker.collider.x = next.x;
  walker.collider.z = next.z;
  if (moved < step * 0.35) {
    walker.stuck += delta;
    if (walker.stuck > 0.6) {
      walker.side *= -1;
      walker.stuck = 0;
    }
  } else {
    walker.stuck = Math.max(0, walker.stuck - delta * 2);
  }
  turnToward(walker, aimX, aimZ, delta, 12);
  setPose(walker, "walk");
}

function pointBlocked(x: number, z: number, y: number, radius: number, colliders: Collider[]) {
  if (y < 0.48) return true;
  for (const collider of colliders) {
    if (collider.hx && collider.hz) {
      const rot = collider.rot ?? 0;
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      const dx = x - collider.x;
      const dz = z - collider.z;
      const lx = dx * cos + dz * sin;
      const lz = -dx * sin + dz * cos;
      if (Math.abs(lx) <= collider.hx + radius && Math.abs(lz) <= collider.hz + radius) return true;
    } else if (Math.hypot(x - collider.x, z - collider.z) < radius + collider.r) return true;
  }
  return false;
}

function boomClear(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  maxDist: number,
  colliders: Collider[],
) {
  const minDist = 1.22;
  let clear = maxDist;
  const steps = 14;
  for (let i = 1; i <= steps; i += 1) {
    const dist = minDist + ((maxDist - minDist) * i) / steps;
    if (pointBlocked(originX + dirX * dist, originZ + dirZ * dist, originY + dirY * dist, 0.24, colliders)) {
      clear = Math.max(minDist, dist - (maxDist - minDist) / steps);
      break;
    }
  }
  return clear;
}

function placeCamera(
  camera: THREE.PerspectiveCamera,
  player: THREE.Vector3,
  yaw: number,
  pitch: number,
  view: ViewMode,
  mode: CamMode,
  delta: number,
  follow: { ready: boolean; position: THREE.Vector3 },
  colliders: Collider[],
  zoom: number,
  camPos: THREE.Vector3,
  lookAt: THREE.Vector3,
  boomDir: THREE.Vector3,
) {
  const forwardX = -Math.sin(yaw);
  const forwardZ = -Math.cos(yaw);
  if (view === "first") {
    if (camera.fov !== 68) {
      camera.fov = 68;
      camera.updateProjectionMatrix();
    }
    camera.position.set(player.x, player.y + 1.52, player.z);
    camera.rotation.order = "YXZ";
    camera.rotation.y = yaw;
    camera.rotation.x = pitch;
    camera.rotation.z = 0;
    follow.ready = false;
    return;
  }

  const rig = {
    explore: { distance: zoom, height: 1.92, shoulder: 0.18, look: 1.18, fov: 52, lerp: 8.5 },
    combat: { distance: Math.min(zoom, 3.15), height: 1.72, shoulder: 0.48, look: 1.28, fov: 48, lerp: 12 },
    aim: { distance: 2.05, height: 1.58, shoulder: 0.68, look: 1.42, fov: 40, lerp: 14 },
    interact: { distance: 3.35, height: 1.82, shoulder: 0.22, look: 1.05, fov: 50, lerp: 6.5 },
    cinematic: { distance: 6.4, height: 3.15, shoulder: 0.1, look: 0.85, fov: 46, lerp: 3.2 },
  }[mode];

  if (Math.abs(camera.fov - rig.fov) > 0.2) {
    camera.fov += (rig.fov - camera.fov) * (1 - Math.exp(-8 * delta));
    camera.updateProjectionMatrix();
  }

  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const lookY = player.y + rig.look;
  lookAt.set(player.x + forwardX * 1.15, lookY, player.z + forwardZ * 1.15);
  const wantedX = player.x - forwardX * rig.distance + rightX * rig.shoulder;
  const wantedY = player.y + rig.height - pitch * 1.15;
  const wantedZ = player.z - forwardZ * rig.distance + rightZ * rig.shoulder;
  boomDir.set(wantedX - lookAt.x, wantedY - lookAt.y, wantedZ - lookAt.z);
  const boomLen = boomDir.length() || 1;
  boomDir.multiplyScalar(1 / boomLen);
  const clear = boomClear(lookAt.x, lookAt.y, lookAt.z, boomDir.x, boomDir.y, boomDir.z, boomLen, colliders);
  const pulled = Math.max(1.22, Math.min(boomLen, clear));
  camPos.set(lookAt.x + boomDir.x * pulled, lookAt.y + boomDir.y * pulled, lookAt.z + boomDir.z * pulled);
  camPos.y = Math.max(0.56, camPos.y);

  const toward = pulled + 0.02 < boomLen ? 16 : rig.lerp;
  if (!follow.ready) {
    follow.position.copy(camPos);
    follow.ready = true;
  } else {
    const blend = 1 - Math.exp(-toward * delta);
    follow.position.lerp(camPos, blend);
  }
  follow.position.y = Math.max(0.56, follow.position.y);
  camera.position.copy(follow.position);
  camera.up.set(0, 1, 0);
  camera.lookAt(lookAt);
}

function addLamps(
  THREE: typeof import("three"),
  scene: THREE.Scene,
  geo: <T extends THREE.BufferGeometry>(geometry: T) => T,
  mat: <T extends THREE.Material>(material: T) => T,
  poleMat: THREE.Material,
  colliders: Collider[],
) {
  const glow = mat(
    new THREE.MeshStandardMaterial({
      color: 0xffe7a8,
      emissive: 0xffd56a,
      emissiveIntensity: 1.4,
    }),
  );
  const poleGeo = geo(new THREE.CylinderGeometry(0.045, 0.06, 1.7, 6));
  const bulbGeo = geo(new THREE.SphereGeometry(0.12, 10, 8));
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2 + 0.2;
    const lamp = new THREE.Group();
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 0.85;
    pole.castShadow = true;
    const bulb = new THREE.Mesh(bulbGeo, glow);
    bulb.position.y = 1.75;
    lamp.add(pole, bulb);
    lamp.position.set(Math.cos(angle) * 9.7, 0, Math.sin(angle) * 9.7);
    scene.add(lamp);
    colliders.push({ x: lamp.position.x, z: lamp.position.z, r: 0.22 });
  }
}

function attachTalkBubble(
  THREE: typeof import("three"),
  actor: Actor,
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
) {
  if (actor.bubble) return;
  const bubble = createBubble(THREE, disposables);
  const inv = 1 / Math.max(actor.group.scale.y, 0.0001);
  bubble.position.set(0, 2.22 * inv, 0);
  bubble.scale.set(1.55 * inv, 0.52 * inv, 1);
  actor.group.add(bubble);
  actor.bubble = bubble;
}

function createBubble(
  THREE: typeof import("three"),
  disposables: Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>,
) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 168;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.visible = false;
  sprite.center.set(0.5, 0);
  sprite.userData.canvas = canvas;
  disposables.add(texture);
  disposables.add(material);
  return sprite;
}

function paintBubble(sprite: THREE.Sprite, text: string) {
  const canvas = sprite.userData.canvas as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(255,252,246,0.96)";
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 152, 28);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(30,51,40,0.18)";
  ctx.stroke();
  ctx.fillStyle = "#1e3328";
  ctx.font = "600 32px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (ctx.measureText(trial).width > 440 && current) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  const start = 84 - ((lines.length - 1) * 36) / 2;
  lines.forEach((line, index) => ctx.fillText(line, 256, start + index * 36));
  const map = (sprite.material as THREE.SpriteMaterial).map;
  if (map) map.needsUpdate = true;
}

function updateTalk(
  speakers: Actor[],
  player: THREE.Vector3,
  delta: number,
  audio: { duck: (on: boolean) => void },
) {
  let closest: Actor | null = null;
  let best = 3.3;
  let stillTalking = false;
  for (const speaker of speakers) {
    speaker.cooldown = Math.max(0, speaker.cooldown - delta);
    if (speaker.talking > 0) {
      speaker.talking -= delta;
      if (speaker.bubble) speaker.bubble.visible = speaker.talking > 0;
      if (speaker.talking > 0) stillTalking = true;
    }
    const spot = actorSpot(speaker);
    const distance = Math.hypot(spot.x - player.x, spot.z - player.z);
    if (distance < best) {
      best = distance;
      closest = speaker;
    }
  }
  if (!closest?.bubble || closest.cooldown > 0 || closest.talking > 0) {
    audio.duck(stillTalking);
    return stillTalking;
  }
  closest.talking = 3.6;
  closest.cooldown = 6.5;
  const text = closest.lines[closest.line % closest.lines.length];
  closest.line += 1;
  paintBubble(closest.bubble, text);
  closest.bubble.visible = true;
  speakNpc(closest, text);
  audio.duck(true);
  return true;
}

function speakNpc(actor: Actor, text: string) {
  if (!("speechSynthesis" in window)) return;
  const synth = window.speechSynthesis;
  const utter = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  const pool = english.length > 0 ? english : voices;
  if (pool.length > 0) {
    const female = pool.filter((voice) => /female|zira|samantha|victoria|susan|moira|google uk english female/i.test(voice.name));
    const male = pool.filter((voice) => /male|david|daniel|alex|fred|rishi|google uk english male/i.test(voice.name));
    const choice = actor.role === "police" || actor.voice % 2 === 1 ? male : female;
    utter.voice = choice[actor.voice % Math.max(choice.length, 1)] ?? pool[actor.voice % pool.length];
  }
  utter.pitch = actor.role === "police" ? 0.8 : actor.voice % 2 === 0 ? 1.12 : 0.9;
  utter.rate = 0.96;
  utter.volume = 1;
  synth.cancel();
  synth.speak(utter);
}

function applySit(group: THREE.Object3D) {
  const bend = (name: string, amount: number) => {
    const bone = group.getObjectByName(name);
    if (!bone) return;
    bone.rotation.x += amount;
    bone.quaternion.setFromEuler(bone.rotation);
  };
  bend("UpperLegL", -1.15);
  bend("UpperLegR", -1.15);
  bend("LowerLegL", 1.25);
  bend("LowerLegR", 1.25);
}

function applyCrouch(group: THREE.Object3D) {
  const bend = (name: string, amount: number) => {
    const bone = group.getObjectByName(name);
    if (!bone) return;
    bone.rotation.x += amount;
    bone.quaternion.setFromEuler(bone.rotation);
  };
  bend("UpperLegL", -0.62);
  bend("UpperLegR", -0.62);
  bend("LowerLegL", 0.78);
  bend("LowerLegR", 0.78);
}

function renderParkLoop(ctx: AudioContext) {
  const seconds = 12;
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const tone = (channel: Float32Array, start: number, freq: number, duration: number, amp: number, decay: number) => {
    const from = Math.max(0, Math.floor(start * rate));
    const to = Math.min(length, Math.floor((start + duration) * rate));
    for (let i = from; i < to; i += 1) {
      const time = (i - from) / rate;
      const env = Math.min(1, time / 0.025) * Math.exp(-time * decay);
      channel[i] += Math.sin(Math.PI * 2 * freq * time) * env * amp;
    }
  };
  const scale = [261.63, 293.66, 329.63, 392, 440, 523.25, 587.33, 659.25];
  const melody = [0, 2, 4, 2, 5, 4, 2, 0, 4, 5, 7, 5, 4, 2, 1, 0, 2, 4, 5, 4, 2, 0, 4, 2];
  melody.forEach((degree, index) => {
    const when = index * 0.48;
    tone(left, when, scale[degree], 0.62, 0.14, 3.1);
    tone(right, when, scale[degree] * 1.002, 0.62, 0.12, 3.1);
  });
  const chords = [
    [130.81, 164.81, 196],
    [110, 164.81, 220],
    [87.31, 130.81, 174.61],
    [98, 146.83, 196],
  ];
  chords.forEach((chord, index) => {
    const duration = index === chords.length - 1 ? 2.6 : 3.15;
    chord.forEach((freq) => {
      tone(left, index * 3, freq, duration, 0.05, 0.5);
      tone(right, index * 3, freq * 1.003, duration, 0.045, 0.5);
    });
  });
  return buffer;
}

function createParkAudio() {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let source: AudioBufferSourceNode | null = null;
  let quiet = false;
  let ducked = false;
  const loud = 0.95;
  const level = () => (quiet ? 0 : ducked ? 0.22 : loud);

  const start = () => {
    if (ctx) {
      if (ctx.state === "suspended") void ctx.resume();
      return;
    }
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = level();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 5200;
    master.connect(filter);
    filter.connect(ctx.destination);
    source = ctx.createBufferSource();
    source.buffer = renderParkLoop(ctx);
    source.loop = true;
    source.connect(master);
    source.start();
  };

  const toggle = () => {
    if (!ctx) {
      start();
      quiet = false;
      return;
    }
    quiet = !quiet;
    master?.gain.setTargetAtTime(level(), ctx.currentTime, 0.06);
  };

  const duck = (on: boolean) => {
    ducked = on;
    if (master && ctx) master.gain.setTargetAtTime(level(), ctx.currentTime, 0.08);
  };

  const stop = () => {
    try {
      source?.stop();
    } catch {
      /* already stopped */
    }
    void ctx?.close();
    ctx = null;
    source = null;
    master = null;
  };

  const status = (): AudioStatus => {
    if (!ctx) return "off";
    return quiet ? "muted" : "on";
  };

  return { start, toggle, stop, muted: () => quiet, status, duck };
}
