#!/usr/bin/env node
/** Start canonical API mocks at the legacy Mockoon ports, with owned shutdown. */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../../../scripts/lib/test-output.ts";

const directory = testOutputPath("mock-services");
if (existsSync(path.join(directory, "control.json")))
  throw new Error(
    "Mock service control record already exists; run stop-all.mjs before starting again",
  );
if (execFileSync("bun", ["--version"], { encoding: "utf8" }).trim() !== "1.4.2")
  throw new Error("Mock services require pinned Bun 1.4.2 on PATH");
mkdirSync(directory, { recursive: true });
const log = openSync(path.join(directory, "daemon.log"), "a", 0o600);
const child = spawn(
  "bun",
  [
    "--conditions=eliza-source",
    fileURLToPath(
      new URL(
        "../../../../scripts/mocks/compatibility-daemon.ts",
        import.meta.url,
      ),
    ),
  ],
  { detached: true, stdio: ["ignore", log, log, "ipc"] },
);
closeSync(log);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill("SIGTERM");
    reject(new Error(`Mock startup timed out; see ${directory}/daemon.log`));
  }, 60_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("exit", (code) => {
    clearTimeout(timer);
    reject(
      new Error(`Mock process exited ${code}; see ${directory}/daemon.log`),
    );
  });
  child.once("message", (message) => {
    if (!message?.ready) return;
    clearTimeout(timer);
    console.log(`Ready: ${message.services.join(", ")}`);
    child.disconnect();
    child.unref();
    resolve();
  });
});
