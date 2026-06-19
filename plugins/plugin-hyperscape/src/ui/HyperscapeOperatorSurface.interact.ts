// View-bundle `interact` capability handler, split out of
// HyperscapeOperatorSurface.tsx so that file exports only React components and
// stays Fast-Refresh-compatible (Vite would full-reload a component file that
// also exports a plain function). The view bundle re-exports `interact` via
// ./hyperscape-view-bundle.ts.

import { client } from "@elizaos/app-core/ui-compat";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-hyperscape-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-hyperscape",
      commands: ["terminal-hyperscape-command", "terminal-hyperscape-control"],
    };
  }
  if (capability === "terminal-hyperscape-command") {
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
  if (capability === "terminal-hyperscape-control") {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const action =
      params?.action === "pause" || params?.action === "resume"
        ? params.action
        : null;
    if (!runId) throw new Error("runId is required");
    if (!action) throw new Error("action must be pause or resume");
    return {
      viewType: "tui",
      control: await client.controlAppRun(runId, action),
    };
  }
  throw new Error(`Unsupported Hyperscape TUI capability: ${capability}`);
}
