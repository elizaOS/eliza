/**
 * Voice Workbench — fragmented-turn browser wiring (#8785). A scripted stream
 * sends one no-response fragment followed by a response fragment; this proves
 * the client carries response state across turn fragments with mocked backends.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-fragmented-turn-wiring.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "fragmented-turn-response-state",
  description:
    "Scripted fragments carry no-response then response states through the client.",
  classes: ["fragmented-turn-wiring"],
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
