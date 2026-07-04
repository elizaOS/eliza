/**
 * Clock example worker publishes a time provider through the remote plugin
 * bootstrap and appends invocation evidence for install smoke tests.
 */
import { appendFileSync } from "node:fs";

const bootstrap = globalThis.__remotePluginBootstrap;
if (!bootstrap) {
  throw new Error(
    "remote-plugin-clock: __remotePluginBootstrap missing — not running inside Bunny Ears",
  );
}

const { context } = bootstrap;
appendFileSync(
  context.logsPath,
  `[${new Date().toISOString()}] remote-plugin-clock worker started\n`,
  "utf8",
);

self.postMessage({
  type: "action",
  action: "log",
  payload: { level: "info", message: "remote-plugin-clock worker ready" },
});

self.postMessage({ type: "ready" });
