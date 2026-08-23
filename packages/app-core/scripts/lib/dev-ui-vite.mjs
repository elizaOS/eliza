/**
 * Resolves the Node-backed Vite subprocess used by app development entrypoints.
 * Vite's runner loader resolves source-conditioned TypeScript packages before
 * the dev server exists, while central validation keeps dashboard and
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
  // Config loading happens before the dev server's resolver exists. The runner
  // loader still applies Vite's TypeScript resolver here; the native loader
  // delegates extensionless source imports to Node and fails on clean
  // source-conditioned workspaces such as @elizaos/core.
  const args = [
    "--conditions=eliza-source",
    "--import",
    "tsx",
    viteCli,
    "--configLoader",
    "runner",
  ];
  if (force) args.push("--force");
  if (port !== undefined) args.push("--port", String(port));
  args.push(...viteArgs);
  return { command: resolvedNodePath, args };
}
