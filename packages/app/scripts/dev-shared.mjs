#!/usr/bin/env node

/**
 * Runs a worktree-scoped Vite server with deterministic registered ports. The
 * registry owns allocation while the shared Vite resolver owns runtime choice.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveViteCommand } from "../../app-core/scripts/lib/dev-ui-vite.mjs";
import {
  defaultRegistryPath,
  normalizeWorktreePath,
  reservePortsForWorktree,
  updateRegistryEntry,
} from "./dev-server-registry.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const worktree = normalizeWorktreePath(path.resolve(appDir, "../.."));
const registryPath = defaultRegistryPath();

const { entry, reused } = await reservePortsForWorktree(worktree, {
  registryPath,
});
const env = {
  ...process.env,
  ELIZA_UI_PORT: String(entry.uiPort),
  ELIZA_API_PORT: String(entry.apiPort),
  VITE_ELIZA_DEV_SHARED: "1",
};

console.log(
  `[dev:shared] worktree=${worktree}\n` +
    `[dev:shared] ui=http://127.0.0.1:${entry.uiPort} api=http://127.0.0.1:${entry.apiPort}\n` +
    `[dev:shared] registry=${registryPath}`,
);

if (reused) {
  console.log("[dev:shared] reusing existing server; Vite was not started");
} else {
  const viteCommand = resolveViteCommand({ appDir });
  const child = spawn(viteCommand.command, viteCommand.args, {
    cwd: appDir,
    env,
    stdio: "inherit",
  });

  const registered = await updateRegistryEntry(
    worktree,
    {
      pid: child.pid,
      startedAt: new Date().toISOString(),
      uiPort: entry.uiPort,
      apiPort: entry.apiPort,
      packageDir: appDir,
    },
    { registryPath, expectedReservationId: entry.reservationId },
  );
  if (!registered) {
    child.kill();
    throw new Error("Lost the dev server reservation before Vite launched");
  }

  function forward(signal) {
    if (!child.killed) child.kill(signal);
  }
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));

  child.on("exit", async (code, signal) => {
    await updateRegistryEntry(
      worktree,
      { pid: null, stoppedAt: new Date().toISOString() },
      { registryPath, expectedReservationId: entry.reservationId },
    );
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
