/**
 * Voice Workbench — attribution-unavailable browser wiring (#8785, #9427).
 *
 * The mocked headful lane round-trips each turn through the client player, but
 * intentionally provides no attribution resolver; it must report attribution as
 * skipped, never fabricate labels from ground-truth speaker metadata. Pure
 * scorer and headless-service tests cover real misattribution failures.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-attribution-unavailable.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "attribution-unavailable-two-party",
  description:
    "Alternating turns round-trip while speaker attribution remains unavailable.",
  classes: ["attribution-unavailable"],
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
