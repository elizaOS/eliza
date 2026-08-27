/**
 * Resolves the Node-backed Vite subprocess used by app development entrypoints.
 * Vite's bundled config loader keeps the renderer and its React plugins on the
 * same Vite major while still resolving source-conditioned TypeScript imports
 * before the dev server exists. Central validation keeps dashboard and
 * shared-worktree launch paths in sync.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveNodeExecPath } from "../run-node-runtime.mjs";

export function resolveViteCommand({
  appDir,
  force = false,
  nodePath,
  port,
  viteArgs = [],
}) {
  const resolvedNodePath =
    nodePath === undefined
      ? resolveNodeExecPath({
          currentExecPath: process.execPath,
          explicitNodePath: process.env.ELIZA_NODE_PATH,
          platform: process.platform,
        })
      : nodePath;
  if (!resolvedNodePath) {
    throw new Error("Node.js is required to run the Vite dev server.");
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
  const args = [
    "--conditions=eliza-source",
    "--import",
    "tsx",
    viteCli,
    "--configLoader",
    "bundle",
  ];
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  args.push(...viteArgs);
  return { command: resolvedNodePath, args };
}
