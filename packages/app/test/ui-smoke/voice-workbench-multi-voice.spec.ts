/**
 * Voice Workbench — multi-voice scenario class (#8785). Two distinct enrolled
 * voices alternate turns; the player must transcribe + round-trip each.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-multi-voice.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "multi-voice-basic",
  description: "Two enrolled voices alternate turns; both get a reply.",
  classes: ["multi-voice"],
  participants: [
    { label: "alice", ttsVoiceId: "voice-a", isOwner: true },
    { label: "bob", ttsVoiceId: "voice-b" },
  ],
  turns: [
    { speaker: "alice", text: "what time is it", expectRespond: true },
    { speaker: "bob", text: "and what is the weather", expectRespond: true },
    { speaker: "alice", text: "thanks", expectRespond: true },
  ],
});
