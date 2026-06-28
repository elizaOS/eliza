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
import { type GoalsDeps, GoalsDomain } from "./domains/goals-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

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

export function withGoals<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGoalService> {
  class LifeOpsGoalServiceMixin extends Base {
    readonly goalsDomain = new GoalsDomain(this, {
      getGoalRecord: (...args) =>
        (this as unknown as GoalsDeps).getGoalRecord(...args),
      getDefinitionRecord: (...args) =>
        (this as unknown as GoalsDeps).getDefinitionRecord(...args),
      listActivitySignals: (...args) =>
        (this as unknown as GoalsDeps).listActivitySignals(...args),
      inspectReminder: (...args) =>
        (this as unknown as GoalsDeps).inspectReminder(...args),
      refreshEffectiveScheduleState: (...args) =>
        (this as unknown as GoalsDeps).refreshEffectiveScheduleState(...args),
      refreshDefinitionOccurrences: (...args) =>
        (this as unknown as GoalsDeps).refreshDefinitionOccurrences(...args),
      buildReminderPreferenceResponse: (...args) =>
        (this as unknown as GoalsDeps).buildReminderPreferenceResponse(...args),
      resolveEffectiveReminderPlan: (...args) =>
        (this as unknown as GoalsDeps).resolveEffectiveReminderPlan(...args),
    });

    async deleteGoal(goalId: string): Promise<void> {
      return this.goalsDomain.deleteGoal(goalId);
    }

    async listGoals(): Promise<LifeOpsGoalRecord[]> {
      return this.goalsDomain.listGoals();
    }

    async getGoal(goalId: string): Promise<LifeOpsGoalRecord> {
      return this.goalsDomain.getGoal(goalId);
    }

    async createGoal(
      request: CreateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord> {
      return this.goalsDomain.createGoal(request);
    }

    async updateGoal(
      goalId: string,
      request: UpdateLifeOpsGoalRequest,
    ): Promise<LifeOpsGoalRecord> {
      return this.goalsDomain.updateGoal(goalId, request);
    }

    async reviewGoal(
      goalId: string,
      now = new Date(),
    ): Promise<LifeOpsGoalReview> {
      return this.goalsDomain.reviewGoal(goalId, now);
    }

    async buildGoalExperienceLoop(
      reference: {
        goalId?: string | null;
        title: string;
        description?: string | null;
        successCriteria?: Record<string, unknown> | null;
      },
      now = new Date(),
    ): Promise<LifeOpsGoalExperienceLoop> {
      return this.goalsDomain.buildGoalExperienceLoop(reference, now);
    }

    async reviewGoalsForWeek(
      now = new Date(),
    ): Promise<LifeOpsWeeklyGoalReview> {
      return this.goalsDomain.reviewGoalsForWeek(now);
    }

    async explainOccurrence(
      occurrenceId: string,
    ): Promise<LifeOpsOccurrenceExplanation> {
      return this.goalsDomain.explainOccurrence(occurrenceId);
    }

    async getOverview(now = new Date()): Promise<LifeOpsOverview> {
      return this.goalsDomain.getOverview(now);
    }

    async listChannelPolicies(): Promise<LifeOpsChannelPolicy[]> {
      return this.goalsDomain.listChannelPolicies();
    }
  }

  return LifeOpsGoalServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsGoalService
  >;
}
