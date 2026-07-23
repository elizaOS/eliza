/**
 * Resolves the Node-backed Vite subprocess used by app development entrypoints.
 * Central validation keeps the dashboard and shared-worktree launch paths in
 * sync while leaving process lifecycle ownership with their orchestrators.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function resolveViteCommand({
  appDir,
  force = false,
  nodePath = process.execPath,
  port,
}) {
  if (!nodePath) {
    throw new Error("Node.js is required to run the Vite dev server.");
  }
  const viteCli = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteCli)) {
    throw new Error(`Vite CLI not found at ${viteCli}. Run bun install first.`);
  }
  const args = [viteCli];
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  return { command: nodePath, args };
}
