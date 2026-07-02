/**
 * Voice Workbench — turn-pause browser wiring (#8785). Turns are separated by
 * injected silent gaps; the player must honour `pausesMs` between mocked
 * backend round-trips.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-turn-pauses.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "pauses-between-turns",
  description: "Silent gaps spliced between turns; each turn still responds.",
  classes: ["turn-pause-wiring"],
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
