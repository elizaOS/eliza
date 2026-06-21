/**
 * Voice Workbench — diarization scenario class (#8785). Overlapping/alternating
 * speakers whose turns must be attributed to the right speaker label; the player
 * round-trips each turn and records the expected diarization label in the report.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-diarization.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "diarization-two-party",
  description: "Two speakers alternate; each turn attributed to its label.",
  classes: ["diarization"],
  participants: [{ label: "speaker_a", isOwner: true }, { label: "speaker_b" }],
  turns: [
    {
      speaker: "speaker_a",
      text: "what is the first item on the agenda",
      expectedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
    {
      speaker: "speaker_b",
      text: "lets cover the budget first",
      expectedSpeakerLabel: "speaker_b",
      expectRespond: true,
    },
    {
      speaker: "speaker_a",
      text: "good idea",
      expectedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
  ],
});
