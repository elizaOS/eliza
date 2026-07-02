/**
 * Voice Workbench — agent-room metadata browser wiring (#8785). A scenario with
 * multiple agent labels drives mocked reply/no-response SSE events through the
 * real client player and verifies the DOM/report response-state mirror.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-agent-room-metadata.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "agent-room-metadata-basic",
  description: "Owner + two agent labels round-trip response-state metadata.",
  classes: ["agent-room-metadata"],
  participants: [
    { label: "owner", isOwner: true },
    { label: "eliza", entityId: "agent-eliza" },
    { label: "scribe", entityId: "agent-scribe" },
  ],
  agents: ["eliza", "scribe"],
  turns: [
    {
      speaker: "owner",
      text: "eliza summarize the last meeting",
      expectRespond: true,
    },
    { speaker: "owner", text: "talking to myself here", expectRespond: false },
    { speaker: "owner", text: "scribe take a note", expectRespond: true },
  ],
});
