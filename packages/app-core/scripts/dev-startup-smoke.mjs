#!/usr/bin/env node
// CI smoke test: boot `bun run dev` and assert the full dev stack reaches a
// usable state (API runtime ready AND Vite UI serving) within a hard time
// budget. Exits non-zero if the budget is exceeded or the dev process dies.
//
// Runs on freshly-allocated ports and a throwaway state dir so it never
// collides with a developer's running dev server or mutates ~/.milady.
//
// Env:
//   ELIZA_DEV_STARTUP_BUDGET_MS  hard ceiling, default 60000 (the "1 minute" gate)
//   ELIZA_DEV_STARTUP_HARD_KILL_MS  grace before SIGKILL on teardown, default 8000

import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { signalSpawnedProcessTree } from "./lib/kill-process-tree.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const BUDGET_MS = Number(process.env.ELIZA_DEV_STARTUP_BUDGET_MS || "60000");
const HARD_KILL_MS = Number(
  process.env.ELIZA_DEV_STARTUP_HARD_KILL_MS || "8000",
);

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`port ${port} never opened`));
        return;
      }
      const socket = createConnection({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function waitForAgentReady(port, deadline) {
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok && (await res.json())?.ready === true) return;
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`API /api/health never reported ready on port ${port}`);
}

async function waitForUiServing(port, deadline) {
  const url = `http://127.0.0.1:${port}/`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const body = await res.text();
        if (body.length > 0) return;
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Vite UI never served HTML on port ${port}`);
}

async function main() {
  const apiPort = await getFreePort();
  let uiPort = await getFreePort();
  if (uiPort === apiPort) uiPort = await getFreePort();
  const stateDir = path.join(
    os.tmpdir(),
    `eliza-dev-startup-smoke-${process.pid}-${Date.now()}`,
  );

  console.log(
    `[dev-startup-smoke] budget=${BUDGET_MS}ms api=${apiPort} ui=${uiPort}`,
  );

  const child = spawn("bun", ["run", "dev"], {
    cwd: repoRoot,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "true",
      ELIZA_API_PORT: String(apiPort),
      ELIZA_UI_PORT: String(uiPort),
      ELIZA_PORT: String(uiPort),
      ELIZA_STATE_DIR: stateDir,
      MILADY_STATE_DIR: stateDir,
      ELIZA_NAMESPACE: "eliza-dev-startup-smoke",
      ELIZA_DEV_NO_WATCH: "1",
      ELIZA_DEV_QUIET_LOGS: "1",
      ELIZA_NO_VISION_DEPS: "1",
      ELIZA_PLUGIN_BOOT_TIMEOUT_MS: "120000",
      FORCE_COLOR: "0",
      NODE_NO_WARNINGS: "1",
    },
  });

  let exitedEarly = null;
  child.on("exit", (code, signal) => {
    exitedEarly = signal ? `signal ${signal}` : `code ${code}`;
  });

  const teardown = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || exitedEarly) return resolve();
      signalSpawnedProcessTree(child, "SIGTERM");
      const t = setTimeout(() => {
        signalSpawnedProcessTree(child, "SIGKILL");
        resolve();
      }, HARD_KILL_MS);
      child.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
    });

  const start = Date.now();
  const deadline = start + BUDGET_MS;

  // Race readiness against the process dying or the budget elapsing.
  const diedOrTimedOut = new Promise((_, reject) => {
    const timer = setInterval(() => {
      if (exitedEarly) {
        clearInterval(timer);
        reject(new Error(`dev process exited early (${exitedEarly})`));
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(
          new Error(
            `startup exceeded budget of ${BUDGET_MS}ms (${((Date.now() - start) / 1000).toFixed(1)}s)`,
          ),
        );
      }
    }, 200);
  });

  try {
    await Promise.race([
      Promise.all([
        waitForPort(apiPort, deadline).then(() =>
          waitForAgentReady(apiPort, deadline),
        ),
        waitForPort(uiPort, deadline).then(() =>
          waitForUiServing(uiPort, deadline),
        ),
      ]),
      diedOrTimedOut,
    ]);
  } catch (err) {
    await teardown();
    console.error(`[dev-startup-smoke] FAIL: ${err.message}`);
    process.exit(1);
  }

  const elapsed = Date.now() - start;
  await teardown();
  console.log(
    `[dev-startup-smoke] PASS: dev stack ready in ${(elapsed / 1000).toFixed(1)}s (budget ${(BUDGET_MS / 1000).toFixed(0)}s)`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`[dev-startup-smoke] unexpected error: ${err?.stack || err}`);
  process.exit(1);
});
