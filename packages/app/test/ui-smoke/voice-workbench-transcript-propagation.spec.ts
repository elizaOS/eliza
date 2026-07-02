/**
 * Voice Workbench — transcript-propagation browser wiring (#8785). The ASR mock
 * returns deterministic text for each turn, so this lane proves transcript
 * propagation through the player/report/DOM rather than recognizer accuracy.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-transcript-propagation.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "transcript-propagation-dictation",
  description: "Mocked transcript segments propagate into the report.",
  classes: ["transcript-propagation"],
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
