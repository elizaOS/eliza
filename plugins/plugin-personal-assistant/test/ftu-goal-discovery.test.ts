/**
 * Covers the post-first-run goal-discovery surface: ftuGoal provider gating
 * (private-only, first-run-complete-only, silent once discovered), the
 * ftu_goal_discovery evaluator's shouldRun gate / parse / processor state
 * transitions, and the no-double-processing guarantee. Deterministic — real
 * stores against the real runtime cache contract, no model call.
 */
import { ChannelType, type IAgentRuntime, type Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createFirstRunStateStore } from "../src/lifeops/first-run/state.ts";
import {
  FTU_GOAL_CONFIDENCE_THRESHOLD,
  ftuGoalDiscoveryEvaluator,
  parseFtuGoalOutput,
} from "../src/lifeops/ftu-goal/evaluator.ts";
import { createFtuGoalStateStore } from "../src/lifeops/ftu-goal/state.ts";
import { createOwnerFactStore } from "../src/lifeops/owner/fact-store.ts";
import { ftuGoalProvider } from "../src/providers/ftu-goal.ts";
import { createOwnerRuntimeStub } from "./first-run-helpers.ts";

const EMPTY_STATE = { values: {}, data: {}, text: "" } as never;

function ownerMessage(
  runtime: IAgentRuntime,
  text: string,
  channelType: ChannelType = ChannelType.DM,
): Memory {
  return {
    id: "msg-owner-1",
    entityId: "owner-entity-1",
    roomId: "room-1",
    agentId: runtime.agentId,
    content: { text, channelType },
    createdAt: Date.now(),
  } as never;
}

async function completeFirstRun(runtime: IAgentRuntime): Promise<void> {
  const store = createFirstRunStateStore(runtime);
  await store.begin("defaults");
  await store.complete();
}

describe("ftuGoal provider gating", () => {
  it("stays quiet while first-run is still pending", async () => {
    const runtime = createOwnerRuntimeStub();
    const result = await ftuGoalProvider.get(
      runtime,
      ownerMessage(runtime, "hello"),
      EMPTY_STATE,
    );
    expect(result.values?.ftuGoalPending).toBe(false);
    expect(result.text).toBe("");
  });

  it("surfaces the discovery affordance once first-run is complete and no goal is known", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const result = await ftuGoalProvider.get(
      runtime,
      ownerMessage(runtime, "hey"),
      EMPTY_STATE,
    );
    expect(result.values?.ftuGoalPending).toBe(true);
    expect(result.text).toMatch(/discover what they value/i);
    expect(result.data?.affordance).toMatchObject({
      kind: "ftu_goal_discovery_pending",
    });
  });

  it("stays quiet on non-private surfaces", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const result = await ftuGoalProvider.get(
      runtime,
      ownerMessage(runtime, "hey", ChannelType.GROUP),
      EMPTY_STATE,
    );
    expect(result.values?.ftuGoalPending).toBe(false);
  });

  it("goes silent once a goal has been discovered", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    await createFtuGoalStateStore(runtime).complete({
      goal: "Ship the iOS app",
      confidence: 0.9,
      discoveredAt: new Date().toISOString(),
    });
    const result = await ftuGoalProvider.get(
      runtime,
      ownerMessage(runtime, "hey"),
      EMPTY_STATE,
    );
    expect(result.values?.ftuGoalPending).toBe(false);
    expect(result.text).toBe("");
  });
});

describe("ftu_goal_discovery evaluator shouldRun gate", () => {
  it("is false before first-run completes", async () => {
    const runtime = createOwnerRuntimeStub();
    const active = await ftuGoalDiscoveryEvaluator.shouldRun({
      runtime,
      message: ownerMessage(runtime, "I want help staying on top of email"),
      options: {},
    });
    expect(active).toBe(false);
  });

  it("is true once first-run is complete and the goal is undiscovered", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const active = await ftuGoalDiscoveryEvaluator.shouldRun({
      runtime,
      message: ownerMessage(runtime, "I want help staying on top of email"),
      options: {},
    });
    expect(active).toBe(true);
  });

  it("is false for the agent's own messages", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const message = {
      ...ownerMessage(runtime, "noted!"),
      entityId: runtime.agentId,
    } as Memory;
    const active = await ftuGoalDiscoveryEvaluator.shouldRun({
      runtime,
      message,
      options: {},
    });
    expect(active).toBe(false);
  });

  it("is false once the goal is discovered — completed discovery never reprocesses", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    await createFtuGoalStateStore(runtime).complete({
      goal: "Ship the iOS app",
      confidence: 0.9,
      discoveredAt: new Date().toISOString(),
    });
    const active = await ftuGoalDiscoveryEvaluator.shouldRun({
      runtime,
      message: ownerMessage(runtime, "also remind me to buy milk"),
      options: {},
    });
    expect(active).toBe(false);
  });
});

describe("ftu_goal_discovery output parsing", () => {
  it("rejects non-object and malformed output", () => {
    expect(parseFtuGoalOutput(null)).toBeNull();
    expect(parseFtuGoalOutput("goal")).toBeNull();
    expect(parseFtuGoalOutput([])).toBeNull();
    expect(parseFtuGoalOutput({ goal: "x", confidence: 1 })).toBeNull();
    expect(
      parseFtuGoalOutput({ goalFound: "yes", goal: "x", confidence: 1 }),
    ).toBeNull();
  });

  it("normalizes valid output: trims goal, clamps confidence, empties goalFound without text", () => {
    expect(
      parseFtuGoalOutput({
        goalFound: true,
        goal: "  Train for a marathon  ",
        confidence: 1.7,
      }),
    ).toEqual({ goalFound: true, goal: "Train for a marathon", confidence: 1 });
    expect(
      parseFtuGoalOutput({ goalFound: true, goal: "   ", confidence: 0.9 }),
    ).toEqual({ goalFound: false, goal: "", confidence: 0.9 });
    expect(
      parseFtuGoalOutput({
        goalFound: false,
        goal: "",
        confidence: Number.NaN,
      }),
    ).toEqual({ goalFound: false, goal: "", confidence: 0 });
  });
});

describe("ftu_goal_discovery processor", () => {
  function processorContext(
    runtime: IAgentRuntime,
    output: { goalFound: boolean; goal: string; confidence: number },
  ) {
    return {
      runtime,
      message: ownerMessage(runtime, "I want help shipping my iOS app"),
      state: EMPTY_STATE,
      options: {},
      prepared: undefined,
      output,
      evaluatorName: ftuGoalDiscoveryEvaluator.name,
    };
  }

  const persistProcessor = ftuGoalDiscoveryEvaluator.processors?.[0];
  if (!persistProcessor) {
    throw new Error("ftu_goal_discovery must register its persist processor");
  }

  it("does not persist below the confidence threshold", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const result = await persistProcessor.process(
      processorContext(runtime, {
        goalFound: true,
        goal: "Ship the iOS app",
        confidence: FTU_GOAL_CONFIDENCE_THRESHOLD - 0.1,
      }),
    );
    expect(result).toBeUndefined();
    expect((await createFtuGoalStateStore(runtime).read()).status).toBe(
      "pending",
    );
    expect(
      (await createOwnerFactStore(runtime).read()).primaryGoal,
    ).toBeUndefined();
  });

  it("persists the primaryGoal fact with provenance and completes the durable state", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    const result = await persistProcessor.process(
      processorContext(runtime, {
        goalFound: true,
        goal: "Ship the iOS app",
        confidence: 0.9,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      values: { ftuGoalDiscovered: true, ftuGoalConfidence: 0.9 },
    });

    const facts = await createOwnerFactStore(runtime).read();
    expect(facts.primaryGoal?.value).toBe("Ship the iOS app");
    expect(facts.primaryGoal?.provenance.source).toBe("agent_inferred");
    expect(facts.primaryGoal?.provenance.note).toContain("msg-owner-1");

    // Durable, not instance-local: a fresh store on the same runtime cache
    // reads the completed record (the PersonalityStore bug class, #14740).
    const record = await createFtuGoalStateStore(runtime).read();
    expect(record.status).toBe("complete");
    expect(record.goal).toMatchObject({
      goal: "Ship the iOS app",
      confidence: 0.9,
      sourceMessageId: "msg-owner-1",
    });
  });

  it("never overwrites an already-discovered goal (idempotence backstop)", async () => {
    const runtime = createOwnerRuntimeStub();
    await completeFirstRun(runtime);
    await persistProcessor.process(
      processorContext(runtime, {
        goalFound: true,
        goal: "Ship the iOS app",
        confidence: 0.9,
      }),
    );
    const second = await persistProcessor.process(
      processorContext(runtime, {
        goalFound: true,
        goal: "A totally different goal",
        confidence: 0.99,
      }),
    );
    expect(second).toBeUndefined();
    const record = await createFtuGoalStateStore(runtime).read();
    expect(record.goal?.goal).toBe("Ship the iOS app");
    // shouldRun is the primary no-reprocessing gate and is now closed too.
    const active = await ftuGoalDiscoveryEvaluator.shouldRun({
      runtime,
      message: ownerMessage(runtime, "more chatter"),
      options: {},
    });
    expect(active).toBe(false);
  });
});
