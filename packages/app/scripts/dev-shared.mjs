#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

const entry = await reservePortsForWorktree(worktree, { registryPath });
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

const child = spawn("bun", ["--bun", "vite"], {
  cwd: appDir,
  env,
  stdio: "inherit",
});

await updateRegistryEntry(
  worktree,
  {
    pid: child.pid,
    startedAt: new Date().toISOString(),
    uiPort: entry.uiPort,
    apiPort: entry.apiPort,
    packageDir: appDir,
  },
  { registryPath },
);

function forward(signal) {
  if (!child.killed) child.kill(signal);
}
process.once("SIGINT", () => forward("SIGINT"));
process.once("SIGTERM", () => forward("SIGTERM"));

child.on("exit", async (code, signal) => {
  await updateRegistryEntry(
    worktree,
    { pid: null, stoppedAt: new Date().toISOString() },
    { registryPath },
  );
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
