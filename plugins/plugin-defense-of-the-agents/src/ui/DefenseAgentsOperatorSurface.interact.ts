// View-bundle `interact` capability handler, split out of
// DefenseAgentsOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible (Vite would full-reload a component file that
// also exports a plain function). The view bundle re-exports `interact` via
// ./defense-of-the-agents-view-bundle.ts.

import { client } from "@elizaos/app-core/ui-compat";
import { LANES } from "./DefenseAgentsOperatorSurface.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-defense-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-defense-of-the-agents",
      lanes: [...LANES],
      primaryCommands: [
        "review strategy",
        "move to top",
        "move to mid",
        "move to bot",
        "recall",
      ],
    };
  }
  if (capability === "terminal-defense-command") {
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
  throw new Error(`Unsupported Defense TUI capability: ${capability}`);
}
