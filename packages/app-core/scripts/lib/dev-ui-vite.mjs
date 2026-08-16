/**
 * Resolves the Node-backed Vite subprocess used by app development entrypoints.
 * The tsx loader lets source-conditioned workspace packages retain NodeNext
 * specifiers while central validation keeps dashboard and shared-worktree
 * launch paths in sync.
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
  // Vite's default config loader bundles vite.config.ts with esbuild before it
  // can listen. This process already installs tsx, so Node can load the config
  // directly and avoid a redundant multi-second bundle on every dev startup.
  // Config loading happens before Vite's own resolver exists. Give the Node
  // child the same workspace-source condition that the client resolver uses
  // so a clean checkout never depends on package dist output.
  const args = [
    "--conditions=eliza-source",
    "--import",
    "tsx",
    viteCli,
    "--configLoader",
    "native",
  ];
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  args.push(...viteArgs);
  return { command: resolvedNodePath, args };
}
