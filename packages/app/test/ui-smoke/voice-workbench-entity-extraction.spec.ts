/**
 * Voice Workbench — entity-extraction scenario class (#8785). Turns name people
 * the agent should extract; the player round-trips each turn and records the
 * expected entity in the per-turn report detail for the benchmark layer to score.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-entity-extraction.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "entity-extraction-names",
  description: "Turns introduce named people the agent should extract.",
  classes: ["entity-extraction"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "schedule a call with jordan next week",
      expectedEntity: "jordan",
      expectRespond: true,
    },
    {
      speaker: "owner",
      text: "and invite priya as well",
      expectedEntity: "priya",
      expectRespond: true,
    },
  ],
});
