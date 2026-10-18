/**
 * GoalsService — the goals back-end (goal CRUD + dedup + similarity scoring).
 *
 * Standalone successor to the goal CRUD half of PA's `withGoals` LifeOps
 * service mixin. It holds its own runtime + {@link GoalsRepository} and the
 * small identity helpers the methods need, so it has no dependency on
 * `@elizaos/plugin-personal-assistant`. Behavior and the data it returns are
 * preserved verbatim from the original mixin.
 *
 * Cross-domain goal logic is NOT here: goal review / overview / experience-loop
 * (`reviewGoal`, `getOverview`, `buildGoalExperienceLoop`,
 * `reviewGoalsForWeek`, `explainOccurrence`) aggregate PA's
 * definition / occurrence / reminder / calendar / activity-signal graph, so
 * they remain LifeOps mixin methods in PA.
 *
 * PA-owned concerns are taken as injected hooks rather than reimplemented:
 *   - `recordAudit` — with PA, audit events persist into PA's shared
 *     `app_lifeops` audit store; without PA, into `app_goals`.
 *   - `releaseGoalReferences` — PA clears its task definitions' references to
 *     a deleted goal; without PA there are none.
 *   - `normalizeOwnership` — ownership normalization carries PA's domain /
 *     subject rules and resolves the owner-entity / agent identity; it stays
 *     PA-owned and is passed in.
 */

import {
  type CreateLifeOpsGoalRequest,
  LIFEOPS_GOAL_STATUSES,
  LIFEOPS_REVIEW_STATES,
  type LifeOpsAuditEventType,
  type LifeOpsGoalDefinition,
  type LifeOpsGoalRecord,
  type LifeOpsOwnership,
  type LifeOpsOwnershipInput,
  type UpdateLifeOpsGoalRequest,
} from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import {
  createGoalDefinition,
  GoalsRepository,
} from "./db/goals-repository.ts";
import {
  fail,
  mergeMetadata,
  normalizeEnumValue,
  normalizeNullableRecord,
  normalizeOptionalRecord,
  normalizeOptionalString,
  requireAgentId,
  requireNonEmptyString,
  requireRecord,
} from "./goal-normalize.ts";

/**
 * A `times_per_day` slot's `key` is its identity: the check-in mapper turns it
 * into the task's `slot-${key}` idempotency key, so two slots sharing a key
 * collapse into one task and the second declared time never gets a check-in.
 * Reject the repeat at the write boundary instead of losing it silently.
 */
function rejectDuplicateSlotKeys(cadence: Record<string, unknown>): void {
  if (cadence.kind !== "times_per_day" || !Array.isArray(cadence.slots)) {
    return;
  }
  const seen = new Set<string>();
  for (const slot of cadence.slots) {
    const key =
      slot && typeof slot === "object" && !Array.isArray(slot)
        ? (slot as Record<string, unknown>).key
        : undefined;
    if (typeof key !== "string" || key.length === 0) continue;
    if (seen.has(key)) {
      fail(
        400,
        `goal cadence times_per_day slots must have unique keys; duplicate key ${JSON.stringify(key)}`,
      );
    }
    seen.add(key);
  }
}

const GOAL_SIMILARITY_STOP_WORDS = new Set([
  "and",
  "the",
  "for",
  "with",
  "that",
  "this",
  "from",
  "before",
  "after",
  "goal",
  "goals",
]);

// One Han, kana or Hangul character carries a syllable or word, so it counts
// twice toward the length floor: 매일 and 毎朝 pass, a lone 犬 does not.
const CJK_SCRIPT_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function tokenizeGoalText(text: string | null | undefined): string[] {
  const raw = typeof text === "string" ? text : "";
  return raw
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (token) =>
        token.length + (token.match(CJK_SCRIPT_CHAR)?.length ?? 0) >= 3 &&
        !GOAL_SIMILARITY_STOP_WORDS.has(token),
    );
}

function buildGoalSimilarityTokens(args: {
  title: string;
  description?: string | null;
  successCriteria?: Record<string, unknown> | null;
}): string[] {
  const tokens = [
    ...tokenizeGoalText(args.title),
    ...tokenizeGoalText(args.description),
    ...tokenizeGoalText(
      args.successCriteria ? JSON.stringify(args.successCriteria) : "",
    ),
  ];
  return [...new Set(tokens)];
}

/**
 * Compute a 0..1 similarity score between a reference goal and an existing
 * candidate. Used by {@link GoalsService.createGoal} for near-duplicate
 * short-circuiting and (in PA) by the goal experience-loop matcher.
 */
export function scoreGoalSimilarity(args: {
  reference: {
    title: string;
    description?: string | null;
    successCriteria?: Record<string, unknown> | null;
  };
  candidate: LifeOpsGoalDefinition;
}): number {
  const referenceTokens = buildGoalSimilarityTokens({
    title: args.reference.title,
    description: args.reference.description,
    successCriteria: args.reference.successCriteria,
  });
  if (referenceTokens.length === 0) {
    return 0;
  }
  const candidateTokens = new Set(
    buildGoalSimilarityTokens({
      title: args.candidate.title,
      description: args.candidate.description,
      successCriteria: normalizeNullableRecord(
        args.candidate.successCriteria,
        "successCriteria",
      ),
    }),
  );
  const overlap = referenceTokens.filter((token) =>
    candidateTokens.has(token),
  ).length;
  if (overlap === 0) {
    return 0;
  }
  const referenceTitleTokens = tokenizeGoalText(args.reference.title);
  const candidateTitleTokens = new Set(tokenizeGoalText(args.candidate.title));
  const titleOverlap = referenceTitleTokens.filter((token) =>
    candidateTitleTokens.has(token),
  ).length;
  const baseScore = overlap / referenceTokens.length;
  const titleBonus =
    referenceTitleTokens.length > 0
      ? (titleOverlap / referenceTitleTokens.length) * 0.35
      : 0;
  return Math.max(0, Math.min(1, baseScore * 0.75 + titleBonus));
}

/**
 * Audit hook signature. Mirrors PA's `recordAudit` exactly; the goal back-end
 * always passes `ownerType: "goal"`.
 */
export type GoalsRecordAudit = (
  eventType: LifeOpsAuditEventType,
  ownerType: "goal",
  ownerId: string,
  reason: string,
  inputs: Record<string, unknown>,
  decision: Record<string, unknown>,
) => Promise<void>;

/**
 * Ownership-normalization hook signature. Mirrors PA's `normalizeOwnership`.
 * Stays PA-owned because it resolves owner-entity / agent identity and applies
 * PA's domain / subject invariants.
 */
export type GoalsNormalizeOwnership = (
  input: LifeOpsOwnershipInput | undefined,
  current?: LifeOpsOwnership,
) => LifeOpsOwnership;

/**
 * Check-in engine hook. Implemented by `GoalsCheckinService`
 * (`./services/checkin.ts`); wired lazily by both construction sites so goal
 * writes keep per-goal check-in tasks on the scheduling spine in sync. A
 * `null` resolution means no check-in engine runs on this runtime (e.g. the
 * service is not registered) and goal writes proceed without scheduling.
 */
export interface GoalsCheckinSync {
  syncGoalCheckins(goal: LifeOpsGoalDefinition): Promise<unknown>;
  removeGoalCheckins(goalId: string): Promise<unknown>;
}

export interface GoalsServiceDependencies {
  recordAudit: GoalsRecordAudit;
  normalizeOwnership: GoalsNormalizeOwnership;
  checkinSync?: () => GoalsCheckinSync | null;
  /** Clear references to a goal that is being deleted from the host's tables. */
  releaseGoalReferences?: (goalId: string) => Promise<void>;
}

export class GoalsService {
  readonly repository: GoalsRepository;
  private readonly recordAudit: GoalsRecordAudit;
  private readonly normalizeOwnership: GoalsNormalizeOwnership;
  private readonly resolveCheckinSync: () => GoalsCheckinSync | null;
  private readonly releaseGoalReferences?: (goalId: string) => Promise<void>;

  constructor(
    private readonly runtime: IAgentRuntime,
    deps: GoalsServiceDependencies,
  ) {
    this.repository = new GoalsRepository(runtime);
    this.recordAudit = deps.recordAudit;
    this.normalizeOwnership = deps.normalizeOwnership;
    this.resolveCheckinSync = deps.checkinSync ?? (() => null);
    this.releaseGoalReferences = deps.releaseGoalReferences;
  }

  private agentId(): string {
    return requireAgentId(this.runtime);
  }

  private async getGoalRecord(goalId: string): Promise<LifeOpsGoalRecord> {
    const goal = await this.repository.getGoal(this.agentId(), goalId);
    if (!goal) {
      fail(404, "life-ops goal not found");
    }
    const links = await this.repository.listGoalLinksForGoal(
      this.agentId(),
      goalId,
    );
    return { goal, links };
  }

  async deleteGoal(goalId: string): Promise<void> {
    const goal = await this.repository.getGoal(this.agentId(), goalId);
    if (!goal) {
      fail(404, "life-ops goal not found");
    }
    await this.releaseGoalReferences?.(goalId);
    await this.repository.deleteGoal(this.agentId(), goalId);
    // The goal row is already gone. Finish its required scheduler cleanup
    // before the audit observer runs, so an audit write failure cannot leave
    // a live check-in that will later notify the owner about a deleted goal.
    await this.resolveCheckinSync()?.removeGoalCheckins(goalId);
    await this.recordAudit(
      "goal_deleted",
      "goal",
      goalId,
      "goal deleted",
      { title: goal.title },
      {},
    );
  }

  async listGoals(): Promise<LifeOpsGoalRecord[]> {
    const goals = await this.repository.listGoals(this.agentId());
    const records: LifeOpsGoalRecord[] = [];
    for (const goal of goals) {
      const links = await this.repository.listGoalLinksForGoal(
        this.agentId(),
        goal.id,
      );
      records.push({ goal, links });
    }
    return records;
  }

  async getGoal(goalId: string): Promise<LifeOpsGoalRecord> {
    return this.getGoalRecord(goalId);
  }

  async createGoal(
    request: CreateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    const ownership = this.normalizeOwnership(request.ownership);
    const requestTitle = requireNonEmptyString(request.title, "title");
    const requestDescription =
      normalizeOptionalString(request.description) ?? "";
    const requestSuccessCriteria = (() => {
      const criteria =
        normalizeOptionalRecord(request.successCriteria, "successCriteria") ??
        {};
      if (Array.isArray(criteria)) {
        fail(400, "successCriteria must be an object, not an array");
      }
      return criteria;
    })();

    // Dedup: short-circuit if a near-duplicate active goal already exists in
    // the same ownership scope. Avoids spamming duplicate rows when the user
    // re-issues the same chat phrase. Threshold 0.85 is conservative; see
    // scoreGoalSimilarity for the scoring algorithm.
    const existingGoals = await this.repository.listGoals(this.agentId());
    const dedupCandidate = (() => {
      let best: { record: LifeOpsGoalDefinition; score: number } | null = null;
      for (const candidate of existingGoals) {
        if (candidate.status !== "active") continue;
        if (candidate.subjectType !== ownership.subjectType) continue;
        if (candidate.subjectId !== ownership.subjectId) continue;
        const score = scoreGoalSimilarity({
          reference: {
            title: requestTitle,
            description: requestDescription,
            successCriteria: requestSuccessCriteria,
          },
          candidate,
        });
        if (score >= 0.85 && (best === null || score > best.score)) {
          best = { record: candidate, score };
        }
      }
      return best;
    })();

    if (dedupCandidate !== null) {
      const links = await this.repository.listGoalLinksForGoal(
        this.agentId(),
        dedupCandidate.record.id,
      );
      await this.recordAudit(
        "goal_created",
        "goal",
        dedupCandidate.record.id,
        "goal create short-circuited by dedup",
        {
          request,
        },
        {
          dedup: true,
          similarityScore: Number(dedupCandidate.score.toFixed(3)),
          existingGoalId: dedupCandidate.record.id,
          status: dedupCandidate.record.status,
          reviewState: dedupCandidate.record.reviewState,
        },
      );
      // Idempotent heal: the dedup winner may predate the check-in engine.
      await this.resolveCheckinSync()?.syncGoalCheckins(dedupCandidate.record);
      return {
        goal: dedupCandidate.record,
        links,
      };
    }

    const goal = createGoalDefinition({
      agentId: this.agentId(),
      ...ownership,
      title: requestTitle,
      description: requestDescription,
      cadence: (() => {
        const cadence = normalizeNullableRecord(request.cadence, "cadence");
        if (cadence && typeof cadence.kind !== "string") {
          fail(400, "goal cadence must include a 'kind' field when provided");
        }
        if (cadence) rejectDuplicateSlotKeys(cadence);
        return cadence ?? null;
      })(),
      supportStrategy: (() => {
        const strategy =
          normalizeOptionalRecord(request.supportStrategy, "supportStrategy") ??
          {};
        if (Array.isArray(strategy)) {
          fail(400, "supportStrategy must be an object, not an array");
        }
        return strategy;
      })(),
      successCriteria: requestSuccessCriteria,
      status:
        request.status === undefined
          ? "active"
          : normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES),
      reviewState:
        request.reviewState === undefined
          ? "idle"
          : normalizeEnumValue(
              request.reviewState,
              "reviewState",
              LIFEOPS_REVIEW_STATES,
            ),
      metadata: mergeMetadata(
        {},
        normalizeOptionalRecord(request.metadata, "metadata"),
      ),
    });
    await this.repository.createGoal(goal);
    await this.recordAudit(
      "goal_created",
      "goal",
      goal.id,
      "goal created",
      {
        request,
      },
      {
        status: goal.status,
        reviewState: goal.reviewState,
      },
    );
    await this.resolveCheckinSync()?.syncGoalCheckins(goal);
    return {
      goal,
      links: [],
    };
  }

  async updateGoal(
    goalId: string,
    request: UpdateLifeOpsGoalRequest,
  ): Promise<LifeOpsGoalRecord> {
    const current = await this.getGoalRecord(goalId);
    const ownership = this.normalizeOwnership(request.ownership, current.goal);
    const nextGoal: LifeOpsGoalDefinition = {
      ...current.goal,
      ...ownership,
      title:
        request.title !== undefined
          ? requireNonEmptyString(request.title, "title")
          : current.goal.title,
      description:
        request.description !== undefined
          ? (normalizeOptionalString(request.description) ?? "")
          : current.goal.description,
      cadence: (() => {
        if (request.cadence === undefined) return current.goal.cadence;
        const cadence = normalizeNullableRecord(request.cadence, "cadence");
        if (cadence && typeof cadence.kind !== "string") {
          fail(400, "goal cadence must include a 'kind' field when provided");
        }
        if (cadence) rejectDuplicateSlotKeys(cadence);
        return cadence ?? null;
      })(),
      supportStrategy:
        request.supportStrategy !== undefined
          ? requireRecord(request.supportStrategy, "supportStrategy")
          : current.goal.supportStrategy,
      successCriteria:
        request.successCriteria !== undefined
          ? requireRecord(request.successCriteria, "successCriteria")
          : current.goal.successCriteria,
      status:
        request.status !== undefined
          ? normalizeEnumValue(request.status, "status", LIFEOPS_GOAL_STATUSES)
          : current.goal.status,
      reviewState:
        request.reviewState !== undefined
          ? normalizeEnumValue(
              request.reviewState,
              "reviewState",
              LIFEOPS_REVIEW_STATES,
            )
          : current.goal.reviewState,
      metadata:
        request.metadata !== undefined
          ? mergeMetadata(
              current.goal.metadata,
              normalizeOptionalRecord(request.metadata, "metadata"),
            )
          : current.goal.metadata,
      updatedAt: new Date(
        Math.max(Date.now(), Date.parse(current.goal.updatedAt) + 1),
      ).toISOString(),
    };
    const updated = await this.repository.updateGoalIfUnchanged(
      nextGoal,
      current.goal.updatedAt,
    );
    if (!updated) {
      fail(
        409,
        "life-ops goal changed while the update was in progress; retry the update",
        "GOAL_UPDATE_CONFLICT",
      );
    }
    await this.recordAudit(
      "goal_updated",
      "goal",
      nextGoal.id,
      "goal updated",
      {
        request,
      },
      {
        status: nextGoal.status,
        reviewState: nextGoal.reviewState,
      },
    );
    await this.resolveCheckinSync()?.syncGoalCheckins(nextGoal);
    return {
      goal: nextGoal,
      links: current.links,
    };
  }
}
