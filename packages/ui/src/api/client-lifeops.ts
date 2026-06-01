import { ElizaClient } from "./client-base";
import type {
  CreateLifeOpsGoalRequest,
  LifeOpsGoalRecord,
} from "./client-types-config";

declare module "./client-base" {
  interface ElizaClient {
    createLifeOpsGoal(
      request: CreateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord>;
  }
}

ElizaClient.prototype.createLifeOpsGoal = async function (
  this: ElizaClient,
  request: CreateLifeOpsGoalRequest,
): Promise<LifeOpsGoalRecord> {
  return this.fetch<LifeOpsGoalRecord>("/api/lifeops/goals", {
    method: "POST",
    body: JSON.stringify(request),
  });
};
