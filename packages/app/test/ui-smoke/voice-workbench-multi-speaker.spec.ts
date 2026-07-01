/**
 * Voice Workbench — multi-speaker scenario class (#8785). Several speakers in one
 * room; the player round-trips each speaker's turn and carries shared
 * conversation context across the turn sequence.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-multi-speaker.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "multi-speaker-room",
  description: "Three speakers take turns addressing the agent.",
  classes: ["multi-speaker"],
  participants: [
    { label: "alice", isOwner: true },
    { label: "bob" },
    { label: "carol" },
  ],
  turns: [
    {
      speaker: "alice",
      text: "start a timer for ten minutes",
      expectRespond: true,
    },
    { speaker: "bob", text: "make it fifteen", expectRespond: true },
    { speaker: "carol", text: "and add a second one", expectRespond: true },
  ],
});
