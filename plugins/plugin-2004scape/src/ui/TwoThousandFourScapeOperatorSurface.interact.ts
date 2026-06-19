// View-bundle `interact` capability handler, split out of
// TwoThousandFourScapeOperatorSurface.tsx so that file exports only React
// components and stays Fast-Refresh-compatible (Vite would full-reload a
// component file that also exports a plain function). The view bundle re-exports
// `interact` via ./2004scape-view-bundle.ts.

import { postAppRunCommand } from "./TwoThousandFourScapeOperatorSurface.helpers";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-2004scape-state") {
    return {
      viewType: "tui",
      appName: "@elizaos/plugin-2004scape",
      commands: [
        "check status",
        "continue tutorial",
        "pause",
        "resume",
        "terminal-2004scape-command",
      ],
    };
  }
  if (capability === "terminal-2004scape-command") {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    const content =
      typeof params?.content === "string" ? params.content.trim() : "";
    if (!runId) throw new Error("runId is required");
    if (!content) throw new Error("content is required");
    return {
      viewType: "tui",
      command: await postAppRunCommand(runId, "message", { content }),
    };
  }
  if (
    capability === "terminal-2004scape-pause" ||
    capability === "terminal-2004scape-resume"
  ) {
    const runId = typeof params?.runId === "string" ? params.runId.trim() : "";
    if (!runId) throw new Error("runId is required");
    const action =
      capability === "terminal-2004scape-pause" ? "pause" : "resume";
    return {
      viewType: "tui",
      control: await postAppRunCommand(runId, "control", { action }),
    };
  }
  throw new Error(`Unsupported 2004scape TUI capability: ${capability}`);
}
