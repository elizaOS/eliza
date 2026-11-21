/**
 * A chat turn waits out a temporary provider rate limit once and re-sends the
 * same planner or evaluator request. Before this, one 429 on either call
 * failed the whole turn after its earlier model calls had been paid for.
 */
import {
  type PlannerTrajectory,
  type RecordedStage,
  runWithStreamingContext,
  type TrajectoryRecorder,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RATE_LIMIT_RETRY_MAX_WAIT_MS,
  rateLimitRetryWaitMs,
  runEvaluator,
} from "../evaluator.ts";
import { runPlannerLoop } from "../planner-loop.ts";

const ANSWER = "Created qa dinner for tomorrow at 5pm.";
const reply = () => ({
  text: "",
  toolCalls: [
    {
      id: "reply",
      name: "REPLY",
      arguments: { text: ANSWER, eliza_turn_scope: "final" },
    },
  ],
});

const rateLimited = (fields: Record<string, unknown> = {}) =>
  Object.assign(new Error("Too Many Requests"), { status: 429, ...fields });
/** The typed wait the Cloud gateway attaches to its 429. */
const reportedWait = (retryAfterMs: number, scope?: string) => ({
  rateLimit: {
    kind: "rate_limited",
    retryAfterMs,
    ...(scope ? { scope } : {}),
  },
});
/** A provider that answers a token-bucket 429 with a whole-minute header. */
const minuteHeader = { responseHeaders: { "retry-after": "60" } };

/** Failures that a wait of seconds cannot clear, or that are not rate limits. */
const NOT_WAITED: Array<[string, Error]> = [
  [
    "spent credit",
    rateLimited({ code: "insufficient_quota", ...reportedWait(10) }),
  ],
  [
    "a quota refusal",
    Object.assign(new Error("token quota exceeded"), { status: 429 }),
  ],
  ["a used-up period allowance", rateLimited(reportedWait(10, "period"))],
  [
    "a rate limit named only in prose",
    new Error("subscription rate limit reached: session limit hit"),
  ],
  [
    "a provider outage",
    Object.assign(new Error("unavailable"), {
      status: 503,
      ...reportedWait(10),
    }),
  ],
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

/** Resolves once the turn is waiting on a timer. */
async function untilWaiting(): Promise<void> {
  for (let turns = 0; vi.getTimerCount() === 0; turns++) {
    if (turns > 1_000) throw new Error("The turn never started waiting");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function planner(
  outputs: Array<ReturnType<typeof reply> | Error>,
  options: { codingMode?: boolean; signal?: AbortSignal } = {},
) {
  const inputs: string[] = [];
  const stages: RecordedStage[] = [];
  const recorder: TrajectoryRecorder = {
    startTrajectory: () => "planner-rate-limit-wait",
    recordStage: async (_id, stage) => {
      stages.push(stage);
    },
    endTrajectory: async () => {},
    load: async () => null,
    list: async () => [],
  };
  const turn = () =>
    runPlannerLoop({
      runtime: {
        useModel: async (_type: unknown, params: Record<string, unknown>) => {
          inputs.push(
            JSON.stringify({ messages: params.messages, tools: params.tools }),
          );
          const output = outputs.shift();
          if (!output) throw new Error("Unexpected planner call");
          if (output instanceof Error) throw output;
          return output;
        },
      },
      context: { id: "planner-rate-limit-wait", events: [] },
      ...(options.codingMode ? { codingMode: true } : {}),
      tools: [
        {
          name: "CALENDAR_CREATE_EVENT",
          description: "Create a calendar event.",
          parameters: { type: "object", properties: {} },
        },
      ],
      executeToolCall: async () => ({ success: true, text: "Created." }),
      evaluate: async () => ({
        success: true,
        decision: "FINISH",
        thought: "The event exists.",
        messageToUser: ANSWER,
      }),
      recorder,
      trajectoryId: "planner-rate-limit-wait",
    });
  const result = options.signal
    ? runWithStreamingContext(
        { onStreamChunk: async () => {}, abortSignal: options.signal },
        turn,
      )
    : turn();
  // The caller awaits the outcome only after it has advanced the clock.
  const outcome = result.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  return { outcome, inputs, stages };
}

describe("rate-limit wait bound", () => {
  it.each([
    ["the Cloud report", rateLimited(reportedWait(1_200)), 1_200],
    ["a provider retry delay", rateLimited({ retryAfterMs: 300 }), 300],
    [
      "a retry header beyond the bound",
      rateLimited(minuteHeader),
      RATE_LIMIT_RETRY_MAX_WAIT_MS,
    ],
    ["no hint", rateLimited(), RATE_LIMIT_RETRY_MAX_WAIT_MS],
    [
      "a wrapped provider error",
      { lastError: rateLimited() },
      RATE_LIMIT_RETRY_MAX_WAIT_MS,
    ],
  ])("waits for %s, at most the bound", (_label, error, expected) => {
    expect(rateLimitRetryWaitMs(error)).toBe(expected);
  });

  it.each(NOT_WAITED)("does not wait for %s", (_label, error) => {
    expect(rateLimitRetryWaitMs(error)).toBeUndefined();
  });
});

describe("chat planner rate-limit wait", () => {
  it("re-sends the same request once after the hinted wait and completes the turn", async () => {
    const { outcome, inputs, stages } = planner([
      rateLimited(reportedWait(1_200)),
      reply(),
    ]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_199);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: { finalMessage: ANSWER } });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toBe(inputs[0]);
    const recorded = stages.filter((stage) => stage.kind === "planner");
    expect(recorded.map((stage) => stage.retryIdx)).toEqual([undefined, 1]);
    expect(recorded.map((stage) => stage.model?.finishReason)).toEqual([
      "error",
      undefined,
    ]);
  });

  it.each([
    ["longer than the bound", rateLimited(minuteHeader)],
    ["absent", rateLimited()],
  ])("waits only the bound when the hint is %s", async (_label, failure) => {
    const { outcome, inputs } = planner([failure, reply()]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MAX_WAIT_MS - 1);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: { finalMessage: ANSWER } });
    expect(inputs).toHaveLength(2);
  });

  it("fails as before when the re-sent request is rate limited again", async () => {
    const second = rateLimited(reportedWait(1_200));
    const { outcome, inputs, stages } = planner([
      rateLimited(reportedWait(1_200)),
      second,
      reply(),
    ]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_200);
    expect(await outcome).toEqual({ error: second });
    expect(inputs).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(
      stages
        .filter((stage) => stage.kind === "planner")
        .map((stage) => stage.retryIdx),
    ).toEqual([undefined, 1]);
  });

  it("stops at once when the turn is aborted during the wait", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled during the wait");
    const { outcome, inputs } = planner([rateLimited(minuteHeader), reply()], {
      signal: controller.signal,
    });
    await untilWaiting();
    controller.abort(reason);
    expect(await outcome).toEqual({ error: reason });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MAX_WAIT_MS);
    expect(inputs).toHaveLength(1);
  });

  it.each(NOT_WAITED)(
    "fails without a wait or re-send on %s",
    async (_label, failure) => {
      const { outcome, inputs } = planner([failure, reply()]);
      expect(await outcome).toEqual({ error: failure });
      expect(inputs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("leaves the coding planner failing fast on a 429 that carries only the Cloud report", async () => {
    const { outcome, inputs } = planner(
      [rateLimited(reportedWait(1_200)), reply()],
      { codingMode: true },
    );
    await outcome;
    expect(inputs).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("chat evaluator rate-limit wait", () => {
  const CONTINUE = JSON.stringify({
    thought: "More work remains.",
    success: false,
    decision: "CONTINUE",
  });

  function evaluator(
    outputs: Array<string | Error>,
    options: { codingMode?: boolean; signal?: AbortSignal } = {},
  ) {
    const context = { id: "evaluator-rate-limit-wait", events: [] };
    const trajectory: PlannerTrajectory = {
      context,
      ...(options.codingMode ? { codingMode: true } : {}),
      steps: [],
      archivedSteps: [],
      plannedQueue: [],
      evaluatorOutputs: [],
    };
    const inputs: string[] = [];
    const evaluate = () =>
      runEvaluator({
        context,
        trajectory,
        runtime: {
          useModel: async (_type: unknown, params: Record<string, unknown>) => {
            inputs.push(JSON.stringify(params.messages));
            const output = outputs.shift();
            if (!output) throw new Error("Unexpected evaluator call");
            if (output instanceof Error) throw output;
            return output;
          },
        },
      });
    const result = options.signal
      ? runWithStreamingContext(
          { onStreamChunk: async () => {}, abortSignal: options.signal },
          evaluate,
        )
      : evaluate();
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    return { outcome, inputs };
  }

  it("re-sends the same request once after the wait", async () => {
    const { outcome, inputs } = evaluator([
      rateLimited(reportedWait(1_200)),
      CONTINUE,
    ]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(1_199);
    expect(inputs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ value: { decision: "CONTINUE" } });
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toBe(inputs[0]);
  });

  it("fails as before when the re-sent request is rate limited again", async () => {
    const second = rateLimited();
    const { outcome, inputs } = evaluator([rateLimited(), second, CONTINUE]);
    await untilWaiting();
    await vi.advanceTimersByTimeAsync(RATE_LIMIT_RETRY_MAX_WAIT_MS);
    expect(await outcome).toEqual({ error: second });
    expect(inputs).toHaveLength(2);
  });

  it("stops at once when the turn is aborted during the wait", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled during the wait");
    const { outcome, inputs } = evaluator([rateLimited(), CONTINUE], {
      signal: controller.signal,
    });
    await untilWaiting();
    controller.abort(reason);
    expect(await outcome).toEqual({ error: reason });
    expect(vi.getTimerCount()).toBe(0);
    expect(inputs).toHaveLength(1);
  });

  it.each([
    ["spent credit", {}, NOT_WAITED[0][1]],
    ["a coding turn", { codingMode: true }, rateLimited(reportedWait(10))],
  ])(
    "fails without a wait or re-send on %s",
    async (_label, options, failure) => {
      const { outcome, inputs } = evaluator([failure, CONTINUE], options);
      expect(await outcome).toEqual({ error: failure });
      expect(inputs).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
