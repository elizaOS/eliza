/**
 * Voice Workbench — diarization scenario class (#8785, #9427). Overlapping /
 * alternating speakers whose turns must be attributed to the right speaker
 * label; the player runs each turn through attribution and records the
 * PREDICTED label (not the ground-truth `speaker`) in the report.
 *
 * Each turn carries an explicit `predictedSpeakerLabel` — the attribution output
 * the diarization gate scores against `expectedSpeakerLabel`. These are distinct
 * fields, so the gate is NOT tautological: a real misattribution (predicted ≠
 * expected) drives DER up and fails the gate. A live attribution model overrides
 * these via `VoiceWorkbenchOptions.resolvePredictedSpeakerLabel`. The fail-on-
 * divergence behavior is unit-tested in
 * `packages/ui/src/voice/voice-selftest/voice-workbench-diarization.test.ts`.
 *
 * The headless lane goes further than these explicit fixture labels: it runs a
 * real blind acoustic clusterer over per-turn audio and scores it with the
 * frame-based DER metric — see
 * `plugins/plugin-local-inference/src/services/voice/acoustic-speaker-attribution.test.ts`
 * and `workbench-logic-services.test.ts` (#9147, #9427).
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
      predictedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
    {
      speaker: "speaker_b",
      text: "lets cover the budget first",
      expectedSpeakerLabel: "speaker_b",
      predictedSpeakerLabel: "speaker_b",
      expectRespond: true,
    },
    {
      speaker: "speaker_a",
      text: "good idea",
      expectedSpeakerLabel: "speaker_a",
      predictedSpeakerLabel: "speaker_a",
      expectRespond: true,
    },
  ],
});
