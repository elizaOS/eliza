/**
 * Resolves the dashboard dev stack's Vite subprocess command. The orchestrator
 * validates Node and the installed CLI before it mutates process state.
 */

import path from "node:path";

export function resolveDevUiViteCommand({
  appDir,
  cwd,
  exists,
  force,
  nodePath,
  uiPort,
}) {
  if (!nodePath) {
    throw new Error("Node.js 24+ is required to run the Vite dev server.");
  }
  const viteCli = path.join(
    cwd,
    appDir,
    "node_modules",
    "vite",
    "bin",
    "vite.js",
  );
  if (!exists(viteCli)) {
    throw new Error(`Vite CLI not found at ${viteCli}. Run bun install first.`);
  }
  return {
    command: nodePath,
    args: force
      ? [viteCli, "--force", "--port", String(uiPort)]
      : [viteCli, "--port", String(uiPort)],
  };
}
