// One process, one port: Next serves the park, the relay shares it.
// Other players only need this URL — no second port, no invite link.

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import next from "next";
import { attachRelay, healthPayload } from "./relay.mjs";

const dev = process.argv.includes("--dev") || process.env.NODE_ENV !== "production";
if (!dev && !process.env.NODE_ENV) process.env.NODE_ENV = "production";

const port = Number(process.env.PORT || 3000);
const lan = lanAddress();
const hostname = lan || "localhost";
let publicUrl = null;

let handle = (req, res) => {
  res.statusCode = 503;
  res.end("starting");
};

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ...healthPayload(),
      lan: lan ? `http://${lan}:${port}` : null,
      public: publicUrl,
    }));
    return;
  }
  handle(req, res);
});

const app = next({
  dev,
  hostname,
  port,
  httpServer: server,
  turbopack: true,
});
await app.prepare();
handle = app.getRequestHandler();

attachRelay(server, { paths: ["/relay"] });

server.listen(port, "0.0.0.0", () => {
  console.log(`The Hangout  http://localhost:${port}`);
  if (lan) console.log(`             http://${lan}:${port}`);
  console.log(`Park relay   ws://localhost:${port}/relay`);
  openLanPort(port);
  startPublicTunnel(port);
});

function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.internal) continue;
      if (addr.family === "IPv4" || addr.family === 4) return addr.address;
    }
  }
  return null;
}

function openLanPort(port) {
  spawn(
    "netsh",
    ["advfirewall", "firewall", "add", "rule", `name=The Hangout ${port}`, "dir=in", "action=allow", "protocol=TCP", `localport=${String(port)}`],
    { stdio: "ignore", windowsHide: true },
  );
}

function startPublicTunnel(port) {
  const child = spawn(
    "npx",
    ["--yes", "cloudflared", "tunnel", "--url", `http://127.0.0.1:${port}`],
    { shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const scan = (buf) => {
    const match = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!match || publicUrl === match[0]) return;
    publicUrl = match[0];
    console.log(`Public park  ${publicUrl}`);
  };
  child.stdout?.on("data", scan);
  child.stderr?.on("data", scan);
  child.on("error", () => {});
}
