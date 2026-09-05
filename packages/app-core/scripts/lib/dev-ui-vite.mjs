/**
 * Resolves the Vite subprocess used by app development entrypoints.
 * Vite's bundled config loader keeps the renderer and its React plugins on the
 * same Vite major while still resolving source-conditioned TypeScript imports
 * before the dev server exists. Central validation keeps dashboard and
 * shared-worktree launch paths in sync.
 *
 * `resolveViteCommand` keeps its generic default (Bun when the caller runs
 * under Bun) so the standalone app launchers stay Bun-backed.
 * `resolveSupervisedViteCommand` pins the combined `bun run dev` supervisor's
 * Vite child to Node 24+: Vite's HTTP/WebSocket proxy calls Node socket methods
 * (for example `socket.destroySoon`) that Bun does not implement, so a
 * Bun-spawned Vite proxy crashes on ordinary `/api` and `/ws` traffic.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveNodeExecPath } from "../run-node-runtime.mjs";

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

/**
 * Resolves the Vite command for the supervised `bun run dev` orchestrator,
 * pinning the child to a Node 24+ executable regardless of the runtime that
 * launched the orchestrator. The supervisor proxies `/api` and `/ws` traffic
 * through Vite, whose proxy relies on Node-only socket methods; spawning that
 * proxy under Bun crashes with `socket.destroySoon is not a function`. The API
 * runtime is resolved independently and may still be Bun-backed.
 *
 * Node resolution reuses the repository's Node-runtime machinery (minimum major
 * enforcement, Bun-executable rejection, `ELIZA_NODE_PATH` override) and throws
 * an actionable error if no compliant Node is available.
 */
export function resolveSupervisedViteCommand({
  appDir,
  force = false,
  port,
  viteArgs = [],
  currentExecPath = process.execPath,
  platform = process.platform,
  explicitNodePath = process.env.ELIZA_NODE_PATH,
  resolveNodePath = resolveNodeExecPath,
}) {
  const runtimePath = resolveNodePath({
    currentExecPath,
    platform,
    explicitNodePath: explicitNodePath?.trim() || undefined,
  });
  return resolveViteCommand({
    appDir,
    force,
    runtime: "node",
    runtimePath,
    port,
    viteArgs,
  });
}
