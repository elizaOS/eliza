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
  // When NODE_OPTIONS carries `--conditions=eliza-source`, workspace packages
  // resolve to their TypeScript sources, whose NodeNext relative specifiers
  // keep `.js` extensions. Node's loader cannot map those onto `.ts` worktree
  // files by itself (Bun could, before the Vite child moved to Node), so the
  // vite.config.ts import graph dies with ERR_MODULE_NOT_FOUND at the first
  // source-conditioned package. tsx restores that mapping, mirroring the API
  // child spawn in dev-ui.mjs.
  const args = ["--import", "tsx", viteCli];
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  return { command: nodePath, args };
}
