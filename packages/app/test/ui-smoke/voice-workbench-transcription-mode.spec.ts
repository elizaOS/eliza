/**
 * Voice Workbench — transcription-mode scenario class (#8785). Dictation: every
 * turn is captured verbatim and the agent acknowledges (responds) each segment,
 * so transcript WER is the load-bearing assertion.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-transcription-mode.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "transcription-dictation",
  description: "Verbatim dictation segments; each acknowledged.",
  classes: ["transcription-mode"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "dear team the quarterly numbers look strong",
      expectedTranscript: "dear team the quarterly numbers look strong",
      expectRespond: true,
    },
    {
      speaker: "owner",
      text: "please review before friday",
      expectedTranscript: "please review before friday",
      expectRespond: true,
    },
  ],
});
