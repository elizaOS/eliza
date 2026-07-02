/**
 * Voice Workbench — turn-detail metadata browser wiring (#8785). Turns carry
 * expected entity hints; the browser lane only proves those hints survive in the
 * per-turn report detail for lower tiers to compare against real model output.
 *
 *   bun run --cwd packages/app test:e2e test/ui-smoke/voice-workbench-turn-detail-metadata.spec.ts
 */
import { runWorkbenchScenarioSpec } from "./voice-workbench-cases";

runWorkbenchScenarioSpec({
  id: "turn-detail-names",
  description: "Expected entity hints are copied into per-turn report detail.",
  classes: ["turn-detail-metadata"],
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
