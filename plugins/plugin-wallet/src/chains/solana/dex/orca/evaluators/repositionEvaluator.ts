// @ts-nocheck — legacy export kept for direct Orca plugin imports
import { createLpRepositionEvaluator } from "../../../../../lp/evaluators/repositionEvaluator.ts";
import { extractManageLpConfig } from "../../manage-lp-positions";

export const managePositionActionRetriggerEvaluator = createLpRepositionEvaluator({
  name: "DEGEN_LP_REPOSITION_EVALUATOR",
  similes: ["DEGEN_LP_REPOSITION"],
  description:
    "Schedules and monitors ongoing repositioning actions to ensure continuous operation.",
  logLabel: "Orca",
  memoryType: "reposition_message",
  extractConfiguration: (text, runtime) => extractManageLpConfig(runtime, text),
});
