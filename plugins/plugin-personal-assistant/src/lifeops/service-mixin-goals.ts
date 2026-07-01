import type {
  CreateLifeOpsGoalRequest,
  LifeOpsChannelPolicy,
  LifeOpsGoalExperienceLoop,
  LifeOpsGoalRecord,
  LifeOpsGoalReview,
  LifeOpsOccurrenceExplanation,
  LifeOpsOverview,
  LifeOpsWeeklyGoalReview,
  UpdateLifeOpsGoalRequest,
} from "../contracts/index.js";

export interface LifeOpsGoalService {
  deleteGoal(goalId: string): Promise<void>;
  listGoals(): Promise<LifeOpsGoalRecord[]>;
  getGoal(goalId: string): Promise<LifeOpsGoalRecord>;
  createGoal(request: CreateLifeOpsGoalRequest): Promise<LifeOpsGoalRecord>;
  updateGoal(
    goalId: string,
    request: UpdateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord>;
  reviewGoal(goalId: string, now?: Date): Promise<LifeOpsGoalReview>;
  explainOccurrence(
    occurrenceId: string,
  ): Promise<LifeOpsOccurrenceExplanation>;
  getOverview(now?: Date): Promise<LifeOpsOverview>;
  listChannelPolicies(): Promise<LifeOpsChannelPolicy[]>;
  buildGoalExperienceLoop(
    reference: {
      goalId?: string | null;
      title: string;
      description?: string | null;
      successCriteria?: Record<string, unknown> | null;
    },
    now?: Date,
  ): Promise<LifeOpsGoalExperienceLoop>;
  reviewGoalsForWeek(now?: Date): Promise<LifeOpsWeeklyGoalReview>;
}
