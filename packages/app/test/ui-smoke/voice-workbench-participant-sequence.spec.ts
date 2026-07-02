/**
 * Voice Workbench — participant-sequence browser wiring (#8785). Several
 * scripted speaker labels take turns; the browser lane proves turn ordering and
 * shared conversation context with mocked backends, not speaker attribution.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-participant-sequence.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "participant-sequence-room",
  description: "Three scripted participants take turns in one conversation.",
  classes: ["participant-sequence"],
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
