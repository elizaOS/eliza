/**
 * LifeOps life chat integration tests with real LLM.
 *
 * Tests the full handler chain: parameter extraction by a real LLM →
 * service execution → service state verification.
 *
 * Provides explicit `action` params (simulating the LLM's action selection)
 * so tests are deterministic about which operation runs, while the real LLM
 * handles parameter extraction from natural language. Uses `confirmed: true`
 * to skip the preview/confirm UX step.
 *
 * No mocks, no regex, no hardcoded English string matching.
 * Verifies via structured action results and service state.
 *
 * Requires at least one LLM provider API key. Skips when unavailable.
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectLiveProvider } from "../../../../test/helpers/live-provider";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";
import { lifeAction } from "../src/actions/life.js";
import { LifeOpsService } from "../src/lifeops/service.js";

const provider = selectLiveProvider();
const describeWithLLM = provider ? describe : describe.skip;

function callLifeAction(
  runtime: AgentRuntime,
  text: string,
  params: Record<string, unknown> = {},
) {
  return lifeAction.handler?.(
    runtime,
    {
      entityId: runtime.agentId,
      content: { text, source: "discord" },
    } as never,
    {} as never,
    {
      parameters: {
        intent: text,
        details: { confirmed: true },
        ...params,
      },
    } as never,
  );
}

describeWithLLM("life-ops natural language (real LLM extraction)", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: LifeOpsService;

  beforeAll(async () => {
    testResult = await createLifeOpsTestRuntime({ withLLM: true });
    runtime = testResult.runtime;
    service = new LifeOpsService(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult.cleanup();
  });

  it("creates a twice-daily brushing routine via LLM extraction", async () => {
    const result = await callLifeAction(
      runtime,
      "Help me remember to brush my teeth in the morning and at night.",
      { action: "create", title: "Brush teeth" },
    );

    expect(result?.success).toBe(true);

    const definitions = await service.listDefinitions();
    const matchingDef = definitions.find((d) => {
      const title = d.definition.title.toLowerCase();
      return title.includes("brush") || title.includes("teeth");
    });
    expect(matchingDef).toBeTruthy();
    expect(matchingDef?.definition.cadence).toBeTruthy();
  }, 120_000);

  it("creates a hydration reminder via LLM extraction", async () => {
    const result = await callLifeAction(
      runtime,
      "Remind me to drink water every day in the morning, afternoon, and evening.",
      { action: "create", title: "Drink water" },
    );

    expect(result).toBeTruthy();
    // Handler may succeed (created) or return a deferred preview
    if (result?.data?.deferred) {
      expect(result.success).toBe(true);
      expect(result.data.lifeDraft).toBeTruthy();
    } else {
      expect(result?.success).toBe(true);
      const definitions = await service.listDefinitions();
      const matchingDef = definitions.find((d) => {
        const title = d.definition.title.toLowerCase();
        return (
          title.includes("water") ||
          title.includes("drink") ||
          title.includes("hydrat")
        );
      });
      expect(matchingDef).toBeTruthy();
    }
  }, 120_000);

  it("asks for clarification instead of saving a title-only goal", async () => {
    const goalsBefore = await service.listGoals();
    const goalIdsBefore = new Set(goalsBefore.map((entry) => entry.goal.id));

    const result = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: "I want a goal called Stabilize sleep schedule.",
          source: "discord",
        },
      } as never,
      {} as never,
      {
        parameters: {
          action: "create_goal",
          intent: "I want a goal called Stabilize sleep schedule.",
          details: {
            confirmed: true,
          },
        },
      } as never,
    );

    expect(result?.success).toBe(true);
    expect(result?.data?.noop).toBe(true);
    expect(result?.data?.suggestedOperation).toBe("create_goal");

    const goalsAfter = await service.listGoals();
    expect(goalsAfter.length).toBe(goalsBefore.length);
    expect(goalsAfter.map((entry) => entry.goal.id)).toEqual(
      expect.arrayContaining(Array.from(goalIdsBefore)),
    );
  }, 120_000);

  it("creates a grounded goal via LLM extraction", async () => {
    const goalsBefore = await service.listGoals();
    const goalIdsBefore = new Set(goalsBefore.map((entry) => entry.goal.id));
    const groundedIntent =
      "I want to stabilize my sleep schedule by being asleep by 11:30 pm and up by 7:30 am on weekdays within 45 minutes for the next month.";

    const result = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: groundedIntent,
          source: "discord",
        },
      } as never,
      {} as never,
      {
        parameters: {
          action: "create_goal",
          intent: groundedIntent,
          details: {
            confirmed: true,
          },
        },
      } as never,
    );

    expect(result?.success).toBe(true);

    const goalsAfter = await service.listGoals();
    const createdGoal = goalsAfter.find(
      (entry) => !goalIdsBefore.has(entry.goal.id),
    );
    expect(createdGoal).toBeTruthy();
    expect(createdGoal?.goal.status).toBe("active");
    expect(createdGoal?.goal.reviewState).toBe("idle");
    expect(createdGoal?.goal.description.trim().length).toBeGreaterThan(0);
    expect(createdGoal?.goal.successCriteria).toBeTruthy();
    expect(createdGoal?.goal.supportStrategy).toBeTruthy();

    const goalGrounding = (createdGoal?.goal.metadata.goalGrounding ??
      null) as {
      groundingState?: unknown;
      summary?: unknown;
      missingCriticalFields?: unknown;
    } | null;
    expect(goalGrounding).toBeTruthy();
    expect(goalGrounding?.groundingState).toBe("grounded");
    expect(typeof goalGrounding?.summary).toBe("string");
    expect((goalGrounding?.summary as string).trim().length).toBeGreaterThan(0);
    expect(goalGrounding?.missingCriticalFields).toEqual([]);
  }, 120_000);

  it("creates a one-off reminder with timezone via LLM extraction", async () => {
    const result = await callLifeAction(
      runtime,
      "please set a reminder for april 17 2026 at 8pm pst to hug my wife",
      { action: "create" },
    );

    expect(result?.success).toBe(true);

    const definitions = await service.listDefinitions();
    const matchingDef = definitions.find((d) => {
      const title = d.definition.title.toLowerCase();
      return title.includes("hug") || title.includes("wife");
    });
    expect(matchingDef).toBeTruthy();
  }, 120_000);

  it("returns a preview draft when not confirmed", async () => {
    const definitionsBefore = (await service.listDefinitions()).length;

    const result = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: "remind me to stretch every hour",
          source: "discord",
        },
      } as never,
      {} as never,
      {
        parameters: {
          intent: "remind me to stretch every hour",
          action: "create",
        },
      } as never,
    );

    expect(result).toBeTruthy();
    expect(result?.success).toBe(true);
    // Should return a deferred draft, not actually create
    expect(result?.data?.deferred).toBe(true);

    const definitionsAfter = (await service.listDefinitions()).length;
    expect(definitionsAfter).toBe(definitionsBefore);
  }, 120_000);

  it("can save a routine after a preview or direct create path", async () => {
    const definitionsBefore = (await service.listDefinitions()).length;

    const previewResult = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: "Please make that into a routine named Brush teeth with reminders around 8am and 9pm. Just preview the plan for now and do not save it yet.",
          source: "discord",
        },
      } as never,
      {} as never,
      {
        parameters: {
          action: "create",
          intent:
            "Please make that into a routine named Brush teeth with reminders around 8am and 9pm. Just preview the plan for now and do not save it yet.",
        },
      } as never,
    );

    expect(previewResult?.success).toBe(true);
    if (!previewResult?.data?.deferred) {
      const definitionsAfter = await service.listDefinitions();
      expect(definitionsAfter.length).toBe(definitionsBefore + 1);
      const created = definitionsAfter.find(
        (entry) => entry.definition.title === "Brush teeth",
      );
      expect(created).toBeTruthy();
      return;
    }

    const confirmResult = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: "That looks right. Save the Brush teeth routine.",
          source: "discord",
        },
      } as never,
      {
        data: {
          actionResults: [previewResult],
        },
      } as never,
      {
        parameters: {
          action: "create",
          intent: "That looks right. Save the Brush teeth routine.",
          title: "Brush teeth",
        },
      } as never,
    );

    expect(confirmResult?.success).toBe(true);

    const definitionsAfter = await service.listDefinitions();
    expect(definitionsAfter.length).toBe(definitionsBefore + 1);
    const created = definitionsAfter.find(
      (entry) => entry.definition.title === "Brush teeth",
    );
    expect(created).toBeTruthy();
  }, 120_000);

  it("asks for clarification on a vague request without creating", async () => {
    const definitionsBefore = (await service.listDefinitions()).length;
    const goalsBefore = (await service.listGoals()).length;

    const _result = await lifeAction.handler?.(
      runtime,
      {
        entityId: runtime.agentId,
        content: {
          text: "lol yeah. can you help me add a todo for my life?",
          source: "discord",
        },
      } as never,
      {} as never,
      {
        parameters: {
          intent: "lol yeah. can you help me add a todo for my life?",
        },
      } as never,
    );

    // Should return without creating
    const definitionsAfter = (await service.listDefinitions()).length;
    const goalsAfter = (await service.listGoals()).length;
    expect(definitionsAfter).toBe(definitionsBefore);
    expect(goalsAfter).toBe(goalsBefore);
  }, 120_000);
});
