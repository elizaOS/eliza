/**
 * Builds the shared Vite server's Node command without starting a process.
 * Keeping command selection pure lets the entrypoint contract stay testable.
 */

import path from "node:path";
import process from "node:process";

export function buildSharedViteCommand(
  appDir,
  { execPath = process.execPath } = {},
) {
  if (!execPath) {
    throw new Error("Node.js 24+ is required to run the Vite dev server.");
  }
  return {
    command: execPath,
    args: [path.join(appDir, "node_modules", "vite", "bin", "vite.js")],
  };
}
