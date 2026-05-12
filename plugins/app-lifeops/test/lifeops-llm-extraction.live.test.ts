/**
 * Live LLM extraction tests for LifeOps actions.
 *
 * These tests still exercise the extractor functions directly, but they now do
 * so through a real AgentRuntime with the actual provider plugin registered.
 * That keeps the surface honest: real runtime, real DB, real model, no fake
 * useModel shim or casted runtime stub.
 */

import crypto from "node:crypto";
import path from "node:path";
import {
  createMessageMemory,
  type IAgentRuntime,
  type Memory,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { stochasticTest } from "../../../packages/app-core/test/helpers/stochastic-test";
import { selectLiveProvider } from "../../../test/helpers/live-provider";
import { extractCalendarPlanWithLlm } from "../src/actions/calendar.js";
import { extractGoalCreatePlanWithLlm } from "../src/actions/lib/extract-goal-plan.js";
import { extractLifeOperationWithLlm } from "../src/actions/lib/extract-life-operation.js";
import { extractTaskCreatePlanWithLlm } from "../src/actions/lib/extract-task-plan.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");
try {
  const { config } = await import("dotenv");
  config({ path: path.join(REPO_ROOT, ".env") });
} catch {
  // dotenv optional
}

const LIVE_ENABLED = process.env.ELIZA_LIVE_TEST === "1";
const provider = LIVE_ENABLED ? selectLiveProvider() : null;

if (!LIVE_ENABLED || !provider) {
  const reasons = [
    !LIVE_ENABLED ? "set ELIZA_LIVE_TEST=1" : null,
    !provider ? "provide a provider API key" : null,
  ]
    .filter(Boolean)
    .join(" | ");
  console.info(`[lifeops-llm-extraction] skipped: ${reasons}`);
}

function makeMessage(runtime: IAgentRuntime, text: string): Memory {
  return createMessageMemory({
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    roomId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId as UUID,
    content: {
      text,
      source: "client_chat",
    },
  });
}

function makeState(recentMessages?: string): State {
  return {
    values: { recentMessages: recentMessages ?? "" },
    data: {},
    text: recentMessages ?? "",
  } as State;
}

const TEST_TIMEOUT = 30_000;
const describeIfLive = LIVE_ENABLED && provider ? describe : describe.skip;

describeIfLive("LLM plan extraction (live)", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;
  let runtime: IAgentRuntime;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime({
      characterName: "LifeOpsExtractorLive",
      preferredProvider: provider?.name,
      withLLM: true,
    });
    runtime = runtimeResult.runtime;
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  describe("extractLifeOperationWithLlm", () => {
    const cases = [
      { intent: "I brushed my teeth", expected: "complete_occurrence" },
      {
        intent: "remind me to take vitamins every morning",
        expected: "create_definition",
      },
      {
        intent:
          "recuérdame cepillarme los dientes por la mañana y por la noche",
        expected: "create_definition",
      },
      {
        intent:
          "Please remind me to brush my teeth in the morning and again at bedtime",
        expected: "create_definition",
      },
      { intent: "less reminders please", expected: "set_reminder_preference" },
      { intent: "how am I doing on my marathon goal", expected: "review_goal" },
      { intent: "skip workout today", expected: "skip_occurrence" },
      { intent: "snooze that reminder", expected: "snooze_occurrence" },
      { intent: "delete my meditation habit", expected: "delete_definition" },
      { intent: "I want to learn guitar this year", expected: "create_goal" },
    ] as const;

    for (const { intent, expected } of cases) {
      stochasticTest(
        `classifies "${intent}" as ${expected}`,
        async () => {
          const result = await extractLifeOperationWithLlm({
            runtime,
            message: makeMessage(runtime, intent),
            state: makeState(),
            intent,
          });
          expect(result.operation).toBe(expected);
          expect(result.confidence).toBeGreaterThan(0);
        },
        { perRunTimeoutMs: TEST_TIMEOUT },
      );
    }
  });

  describe("extractTaskCreatePlanWithLlm", () => {
    const cases = [
      {
        intent: "make sure I brush my teeth when I wake up and before bed",
        expectedMode: "create",
        expectedCadenceKind: "daily",
        expectedWindows: ["morning", "night"],
      },
      {
        intent:
          "recuérdame cepillarme los dientes por la mañana y por la noche",
        expectedMode: "create",
        expectedCadenceKind: "daily",
        expectedWindows: ["morning", "night"],
      },
      {
        intent:
          "set a reminder for april 17 at 8pm mountain time to hug my wife",
        expectedMode: "create",
        expectedCadenceKind: "once",
        expectedTimeOfDay: "20:00",
        expectedTimeZone: "America/Denver",
      },
      {
        intent: "please remind me to shave twice a week",
        expectedMode: "create",
        expectedCadenceKind: "weekly",
      },
    ] as const;

    for (const testCase of cases) {
      stochasticTest(
        `extracts a task-create plan for "${testCase.intent}"`,
        async () => {
          const plan = await extractTaskCreatePlanWithLlm({
            runtime,
            intent: testCase.intent,
            state: makeState(),
            message: makeMessage(runtime, testCase.intent),
          });
          expect(plan?.mode).toBe(testCase.expectedMode);
          expect(plan?.cadenceKind).toBe(testCase.expectedCadenceKind);
          if ("expectedWindows" in testCase && testCase.expectedWindows) {
            expect(plan?.windows).toEqual(
              expect.arrayContaining(testCase.expectedWindows),
            );
          }
          if ("expectedTimeOfDay" in testCase && testCase.expectedTimeOfDay) {
            expect(plan?.timeOfDay).toBe(testCase.expectedTimeOfDay);
          }
          if ("expectedTimeZone" in testCase && testCase.expectedTimeZone) {
            expect(plan?.timeZone).toBe(testCase.expectedTimeZone);
          }
          expect(String(plan?.title ?? "").trim().length).toBeGreaterThan(0);
        },
        { perRunTimeoutMs: TEST_TIMEOUT },
      );
    }
  });

  describe("extractGoalCreatePlanWithLlm", () => {
    stochasticTest(
      "asks for clarification on a title-only goal",
      async () => {
        const intent = "I want a goal called Stabilize sleep schedule.";
        const plan = await extractGoalCreatePlanWithLlm({
          runtime,
          intent,
          state: makeState(),
          message: makeMessage(runtime, intent),
        });
        expect(plan.mode).toBe("respond");
        expect(plan.groundingState).toBe("partial");
        expect(plan.response).toBeTruthy();
        expect(plan.missingCriticalFields.length).toBeGreaterThan(0);
      },
      { perRunTimeoutMs: TEST_TIMEOUT },
    );
  });

  describe("extractCalendarPlanWithLlm", () => {
    const cases = [
      {
        intent: "what's on my calendar today",
        expectedSubaction: "feed",
      },
      {
        intent: "what's my next meeting",
        expectedSubaction: "next_event",
      },
      {
        intent: "find my return flight",
        expectedSubaction: "search_events",
        expectQueries: true,
      },
      {
        intent: "schedule a meeting with Alex at 3pm tomorrow",
        expectedSubaction: "create_event",
      },
      {
        intent: "what do I have while I'm in Tokyo",
        expectedSubaction: "trip_window",
        expectTripLocation: true,
      },
      {
        intent: "meetings with my colleague this week",
        expectedSubaction: "search_events",
        expectQueries: true,
      },
    ] as const;

    for (const testCase of cases) {
      stochasticTest(
        `classifies "${testCase.intent}" as ${testCase.expectedSubaction}`,
        async () => {
          const plan = await extractCalendarPlanWithLlm(
            runtime,
            makeMessage(runtime, testCase.intent),
            makeState(),
            testCase.intent,
          );
          expect(plan.subaction).toBe(testCase.expectedSubaction);
          if ("expectQueries" in testCase && testCase.expectQueries) {
            expect(plan.queries.length).toBeGreaterThan(0);
          }
          if ("expectTripLocation" in testCase && testCase.expectTripLocation) {
            expect(plan.tripLocation).toBeTruthy();
          }
        },
        { perRunTimeoutMs: TEST_TIMEOUT },
      );
    }
  });
});
