/**
 * Resolves the Vite subprocess used by app development entrypoints.
 * Vite's bundled config loader keeps the renderer and its React plugins on the
 * same Vite major while still resolving source-conditioned TypeScript imports
 * before the dev server exists. Central validation keeps dashboard and
 * shared-worktree launch paths in sync.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function resolveViteCommand({
  appDir,
  force = false,
  runtime = process.versions.bun ? "bun" : "node",
  runtimePath = process.execPath,
  port,
  viteArgs = [],
}) {
  if (!runtimePath?.trim()) {
    throw new Error(
      "A JavaScript runtime is required to run the Vite dev server.",
    );
  }
  const viteCli = path.join(appDir, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteCli)) {
    throw new Error(`Vite CLI not found at ${viteCli}. Run bun install first.`);
  }
  // Config loading happens before the dev server's resolver exists. Vite 8's
  // runner loader can resolve the workspace's Vite 7 test alias while
  // @vitejs/plugin-react resolves Vite 8, mixing Rollup and Rolldown plugin
  // contexts and failing every dev request with `Missing field moduleType`.
  // The bundled loader keeps one Vite owner and still handles the config's
  // source TypeScript graph; the tsx import remains for source-conditioned
  // runtime modules loaded after config evaluation.
  const args = ["--conditions=eliza-source"];
  // Node needs tsx for source-conditioned TypeScript runtime modules. Bun
  // handles those modules natively, and loading tsx under Bun fails before
  // Vite starts because tsx's Node-specific CJS bridge cannot be resolved.
  if (runtime === "node") args.push("--import", "tsx");
  args.push(viteCli, "--configLoader", "bundle");
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  args.push(...viteArgs);
  return { command: runtimePath, args };
}
