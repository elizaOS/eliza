/**
 * Voice Workbench — participant voice metadata browser wiring (#8785). Two
 * participants carry distinct voice IDs; this browser lane only proves their
 * scripted turns transcribe and round-trip with mocked backends.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-participant-voice-metadata.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "participant-voice-metadata-basic",
  description: "Two participant voice IDs ride along while turns round-trip.",
  classes: ["participant-voice-metadata"],
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
