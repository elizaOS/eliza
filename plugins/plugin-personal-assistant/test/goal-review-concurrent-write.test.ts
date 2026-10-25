/**
 * Goal review persistence on a real PGlite runtime: a review computed from an
 * earlier read of the goal (it can span an LLM evaluation) must record its
 * review state and metadata without reverting an edit or check-in written to
 * the same goal in the meantime.
 */

import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  createLifeOpsGoalDefinition,
  LifeOpsRepository,
} from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";

let runtimeResult: RealTestRuntimeResult | null = null;

beforeEach(async () => {
  runtimeResult = await createRealTestRuntime();
  await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
});

afterEach(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

it("records a review from a stale goal without reverting a concurrent edit", async () => {
  const runtime = runtimeResult?.runtime;
  if (!runtime) throw new Error("runtime not started");
  const repository = new LifeOpsRepository(runtime);
  const goal = createLifeOpsGoalDefinition({
    agentId: runtime.agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: runtime.agentId,
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    title: "Run 5k",
    description: "",
    cadence: { kind: "weekly" },
    supportStrategy: {},
    successCriteria: {},
    status: "active",
    reviewState: "on_track",
    metadata: { checkinLog: ["week 1"] },
  });
  await repository.createGoal(goal);
  const stale = await repository.getGoal(runtime.agentId, goal.id);
  if (!stale) throw new Error("goal not stored");

  // The owner edits the goal and a check-in lands while the review runs.
  await repository.updateGoal({
    ...stale,
    title: "Run 10k",
    metadata: { checkinLog: ["week 1", "week 2"] },
    updatedAt: "2026-10-06T12:00:00.000Z",
  });

  const service = new LifeOpsService(runtime);
  await service.goalsDomain.syncComputedGoalReviewState(
    stale,
    "at_risk",
    {
      linkedDefinitionCount: 0,
      activeOccurrenceCount: 0,
      overdueOccurrenceCount: 1,
      completedLast7Days: 0,
      lastActivityAt: null,
      reviewState: "at_risk",
      explanation: "No runs logged this week.",
    },
    null,
    new Date("2026-10-06T12:05:00.000Z"),
  );

  const stored = await repository.getGoal(runtime.agentId, goal.id);
  expect(stored).toMatchObject({ title: "Run 10k", reviewState: "at_risk" });
  expect(stored?.metadata.checkinLog).toEqual(["week 1", "week 2"]);
  expect(stored?.metadata.computedGoalReview).toMatchObject({
    reviewState: "at_risk",
  });
}, 120_000);
