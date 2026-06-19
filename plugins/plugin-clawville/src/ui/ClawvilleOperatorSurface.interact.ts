// View-bundle `interact` capability handler, split out of
// ClawvilleOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible (Vite would full-reload a component file that
// also exports a plain function). The view bundle re-exports `interact` via
// ./clawville-view-bundle.ts.

import { client } from "@elizaos/ui";
import { PRIMARY_COMMANDS } from "./ClawvilleOperatorSurface.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-clawville-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-clawville",
      primaryCommands: PRIMARY_COMMANDS.map((item) => item.command),
    };
  }
  if (capability === "terminal-clawville-command") {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const content =
      typeof params?.content === "string" ? params.content.trim() : "";
    if (!runId) throw new Error("runId is required");
    if (!content) throw new Error("content is required");
    return {
      viewType: "tui",
      command: await client.sendAppRunMessage(runId, content),
    };
  }
  throw new Error(`Unsupported ClawVille TUI capability: ${capability}`);
}
