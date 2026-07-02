/**
 * Voice Workbench — speaker-label metadata browser wiring (#8785). Each turn
 * carries an expected speaker label; the browser lane verifies that label is
 * reported as metadata while predicted labels stay unavailable without a real
 * attribution/recognition model.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-speaker-label-metadata.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "speaker-label-metadata-owner",
  description: "Expected speaker labels are copied into the per-turn report.",
  classes: ["speaker-label-metadata"],
  participants: [
    { label: "owner", entityId: "entity-owner", isOwner: true },
    { label: "guest", entityId: "entity-guest" },
  ],
  turns: [
    {
      speaker: "owner",
      text: "read me my messages",
      expectedSpeakerLabel: "owner",
      expectRespond: true,
    },
    {
      speaker: "guest",
      text: "can you play some music",
      expectedSpeakerLabel: "guest",
      expectRespond: true,
    },
  ],
});
