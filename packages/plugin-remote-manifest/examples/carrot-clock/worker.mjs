import { appendFileSync } from "node:fs";

const bootstrap = globalThis.__remotePluginBootstrap;
if (!bootstrap) {
  throw new Error(
    "carrot-clock: __remotePluginBootstrap missing — not running inside Bunny Ears",
  );
}

const { context } = bootstrap;
appendFileSync(
  context.logsPath,
  `[${new Date().toISOString()}] carrot-clock worker started\n`,
  "utf8",
);

self.postMessage({
  type: "action",
  action: "log",
  payload: { level: "info", message: "carrot-clock worker ready" },
});

self.postMessage({ type: "ready" });
