import type { Plugin } from "@elizaos/core";
import { type IAgentRuntime, logger } from "@elizaos/core";
import { cancelGoalAction } from "./actions/cancelGoal.js";
import { completeGoalAction } from "./actions/completeGoal.js";
import { confirmGoalAction } from "./actions/confirmGoal.js";
import { createGoalAction } from "./actions/createGoal.js";
import { updateGoalAction } from "./actions/updateGoal.js";
import { routes } from "./apis.js";
import { goalsProvider } from "./providers/goals.js";
import { goalSchema } from "./schema.js";
import { GoalDataServiceWrapper } from "./services/goalDataService.js";
import { GoalsPluginE2ETestSuite } from "./tests.js";

export const GoalsPlugin: Plugin = {
  name: "goals",
  description: "Provides goal management functionality for tracking and achieving objectives.",
  providers: [goalsProvider],
  testDependencies: ["@elizaos/plugin-sql"],
  actions: [
    createGoalAction,
    completeGoalAction,
    confirmGoalAction,
    updateGoalAction,
    cancelGoalAction,
  ],
  services: [GoalDataServiceWrapper],
  routes,
  schema: goalSchema,
  tests: [GoalsPluginE2ETestSuite],

  async init(_config: Record<string, string>, runtime: IAgentRuntime): Promise<void> {
    if (runtime.db) {
      logger.info("Database available, GoalsPlugin ready for operation");
    } else {
      logger.warn("No database instance available, operations will be limited");
    }
    logger.info("GoalsPlugin initialized successfully");
  },
};

export default GoalsPlugin;

export { goalSchema } from "./schema.js";
export type { GoalData } from "./services/goalDataService.js";
export {
  createGoalDataService,
  GoalDataServiceWrapper,
} from "./services/goalDataService.js";
