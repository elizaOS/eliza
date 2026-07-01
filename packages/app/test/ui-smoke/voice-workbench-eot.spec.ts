/**
 * Voice Workbench — end-of-turn (EOT) scenario class (#8785). A single speaker
 * speaks in fragments separated by short pauses that must NOT be treated as
 * end-of-turn; the agent answers once the full thought lands.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-eot.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "eot-fragmented-thought",
  description:
    "Mid-sentence pauses are not end-of-turn; final fragment replies.",
  classes: ["eot"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "set an alarm for",
      expectRespond: false,
      pausesMs: [120],
    },
    {
      speaker: "owner",
      text: "seven thirty tomorrow morning",
      expectRespond: true,
    },
  ],
});
