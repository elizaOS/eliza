/**
 * Voice Workbench — voice-recognition scenario class (#8785). Each turn carries
 * an enrolled voice that should resolve to an elizaOS entity. The owner's voice
 * is recognized; the player round-trips each turn and records the expected
 * speaker label for the benchmark layer's voice→entity match rate.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-voice-recognition.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "voice-recognition-owner",
  description: "Owner voice resolves to its entity across turns.",
  classes: ["voice-recognition"],
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
