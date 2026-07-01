/**
 * Voice Workbench — multi-agent-room scenario class (#8785). A room with the
 * owner plus more than one agent participant; addressed turns get a reply while
 * an aside meant for another human is ignored. The player drives each turn
 * through the real client loop and scores the respond decisions.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-multi-agent-room.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "multi-agent-room-basic",
  description:
    "Owner + two agents in a room; addressed turns reply, asides do not.",
  classes: ["multi-agent-room"],
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
