import type { Plugin } from "@elizaos/core";
import { completeTaskAction } from "./actions/completeTask";
import { createPlanAction } from "./actions/createPlan";
import { getPlanAction } from "./actions/getPlan";
import { updatePlanAction } from "./actions/updatePlan";
import { planStatusProvider } from "./providers/planStatus";

export const planningPlugin: Plugin = {
  name: "@elizaos/plugin-planning-ts",
  description:
    "Plugin for planning and task management with create, update, complete, and get capabilities",
  actions: [createPlanAction, updatePlanAction, completeTaskAction, getPlanAction],
  providers: [planStatusProvider],
};

export { completeTaskAction } from "./actions/completeTask";
export { createPlanAction } from "./actions/createPlan";
export { getPlanAction } from "./actions/getPlan";
export { updatePlanAction } from "./actions/updatePlan";
export { planStatusProvider } from "./providers/planStatus";
export {
  type CompleteTaskParameters,
  type CreatePlanParameters,
  decodePlan,
  encodePlan,
  formatPlan,
  type GetPlanParameters,
  generatePlanId,
  generateTaskId,
  getPlanProgress,
  PLAN_SOURCE,
  PLAN_STATUS_LABELS,
  type Plan,
  type PlanMetadata,
  type PlanMetadataValue,
  PlanStatus,
  TASK_STATUS_LABELS,
  type Task,
  TaskStatus,
  type UpdatePlanParameters,
} from "./types";
