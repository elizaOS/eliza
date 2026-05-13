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

// Demonstrate the host-request round-trip end-to-end. Equivalent to upstream's
// `Carrots.list()` which resolves to `bridge.requestHost("list-carrots")`.
// Done by raw postMessage to keep the example free of the electrobun import.
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
      ? `ok ${Array.isArray(data.payload) ? data.payload.length : "?"} carrots`
      : `err ${data.error ?? "unknown"}`;
    appendFileSync(context.logsPath, `[list-carrots] ${summary}\n`, "utf8");
  }
});

self.postMessage({
  type: "host-request",
  requestId: LIST_REQUEST_ID,
  method: "list-carrots",
});

self.postMessage({ type: "ready" });
