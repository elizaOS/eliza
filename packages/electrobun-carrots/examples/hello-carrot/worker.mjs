import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const bootstrap = globalThis.__bunnyCarrotBootstrap;
if (!bootstrap) {
  throw new Error("hello-carrot: __bunnyCarrotBootstrap missing — not running inside Bunny Ears");
}

const { manifest, context } = bootstrap;
const stateDir = dirname(context.statePath);
mkdirSync(stateDir, { recursive: true });

const bootStamp = new Date().toISOString();
writeFileSync(
  context.statePath,
  `${JSON.stringify({ carrot: manifest.id, bootedAt: bootStamp }, null, 2)}\n`,
  "utf8",
);

appendFileSync(context.logsPath, `[${bootStamp}] hello-carrot booted (channel=${context.channel})\n`, "utf8");

self.postMessage({
  type: "action",
  action: "log",
  payload: { level: "info", message: `hello-carrot ready, permissions=${context.permissions.join(",")}` },
});

self.postMessage({ type: "ready" });
