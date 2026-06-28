/**
 * Voice Workbench — diarization scenario class (#8785, #9427). Alternating
 * speakers need a real attribution output before DER can be scored.
 *
 * The mocked headful lane round-trips each turn through the client player, but
 * intentionally provides no attribution resolver; it must report diarization as
 * skipped, never as a fake pass from ground-truth labels. Pure scorer and
 * headless-service tests cover real misattribution failures separately.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-diarization.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "diarization-two-party",
  description:
    "Two speakers alternate; each turn attributed to its predicted label.",
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
