import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const bootstrap = globalThis.__remotePluginBootstrap;
if (!bootstrap) {
  throw new Error(
    "hello-remote-plugin: __remotePluginBootstrap missing — not running inside Bunny Ears",
  );
}

const { manifest, context } = bootstrap;
const stateDir = dirname(context.statePath);
mkdirSync(stateDir, { recursive: true });

const bootStamp = new Date().toISOString();
writeFileSync(
  context.statePath,
  `${JSON.stringify({ remotePluginId: manifest.id, bootedAt: bootStamp }, null, 2)}\n`,
  "utf8",
);

appendFileSync(
  context.logsPath,
  `[${bootStamp}] hello-remote-plugin booted (channel=${context.channel})\n`,
  "utf8",
);

self.postMessage({
  type: "action",
  action: "log",
  payload: {
    level: "info",
    message: `hello-remote-plugin ready, permissions=${context.permissions.join(",")}`,
  },
});

const LIST_REQUEST_ID = 1;
self.addEventListener("message", (event) => {
  const data = event.data;
  if (
    data &&
    typeof data === "object" &&
    data.type === "host-response" &&
    data.requestId === LIST_REQUEST_ID
  ) {
    const summary = data.success
      ? `ok ${Array.isArray(data.payload) ? data.payload.length : "?"} remote plugins`
      : `err ${data.error ?? "unknown"}`;
    appendFileSync(
      context.logsPath,
      `[list-remote-plugins] ${summary}\n`,
      "utf8",
    );
  }
});

self.postMessage({
  type: "host-request",
  requestId: LIST_REQUEST_ID,
  method: "list-remote-plugins",
});

self.postMessage({ type: "ready" });
