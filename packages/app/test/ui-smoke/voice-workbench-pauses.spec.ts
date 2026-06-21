/**
 * Voice Workbench — pauses scenario class (#8785). Turns are separated by
 * injected silent gaps; the player must honour `pausesMs` between turns and
 * still round-trip each turn.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-pauses.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "pauses-between-turns",
  description: "Silent gaps spliced between turns; each turn still responds.",
  classes: ["pauses"],
  participants: [{ label: "owner", isOwner: true }],
  turns: [
    {
      speaker: "owner",
      text: "remind me to call mom",
      expectRespond: true,
      pausesMs: [200],
    },
    {
      speaker: "owner",
      text: "actually make it tomorrow",
      expectRespond: true,
      pausesMs: [150, 150],
    },
  ],
});
