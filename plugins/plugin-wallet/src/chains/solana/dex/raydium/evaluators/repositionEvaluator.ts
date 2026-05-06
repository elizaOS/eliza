// @ts-nocheck — legacy export kept for direct Raydium plugin imports
import { createLpRepositionEvaluator } from "../../../../../lp/evaluators/repositionEvaluator.ts";
import { extractManageLpConfig } from "../../manage-lp-positions";

export const managePositionActionRetriggerEvaluator = createLpRepositionEvaluator({
  name: "RAYDIUM_REPOSITION_EVALUATOR",
  similes: ["RAYDIUM_REPOSITION"],
  description:
    "Schedules and monitors ongoing repositioning actions for Raydium positions to ensure continuous operation.",
  logLabel: "Raydium",
  memoryType: "raydium_reposition_message",
  extractConfiguration: (text, runtime) => extractManageLpConfig(runtime, text),
});
