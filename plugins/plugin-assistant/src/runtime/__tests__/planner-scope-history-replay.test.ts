import type { ChatMessage } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop.ts";

// tj-97b3ddd147b529 ("Find me a 30-minute slot tomorrow afternoon."): after a
// pending-scope CALENDAR_FEED call was rejected with ACTION_ARGUMENTS_INVALID,
// both retries copied the earlier calls from history, which had the scope
// stripped, and the turn stopped on repeated invalid scope declarations.

const tools = [
  {
    name: "CALENDAR_FEED",
    parameters: {
      type: "object" as const,
      properties: { details: { type: "object" as const } },
      required: ["details"],
    },
  },
];

const read = {
  success: true,
  text: "Oct 31 agenda: 13:00-15:00 and 16:00-18:00 busy.",
  effectReceipts: [
    {
      receiptId: "feed-read",
      operation: "calendar.feed.read",
      resource: { kind: "calendar.feed", id: "feed" },
      artifacts: [],
      idempotency: { key: null, replayed: false },
      observedAt: "2026-10-30T11:35:28.546Z",
      outcome: "noop" as const,
      reason: "Read only",
    },
  ],
};

const rejected = {
  success: false,
  text: "Argument 'details' did not satisfy any oneOf branch",
  error: "Argument 'details' did not satisfy any oneOf branch",
  data: {
    acceptance: "rejected",
    executionStatus: "not_started",
    parameterErrors: ["Argument 'details' did not satisfy any oneOf branch"],
  },
  failureProvenance: {
    kind: "handler_error" as const,
    boundary: "handler" as const,
    code: "ACTION_ARGUMENTS_INVALID",
    retryable: true,
  },
};

const finish = JSON.stringify({
  completed: true,
  toolCalls: [],
  messageToUser: "12:00 to 12:30 PM is open.",
});

/** Finishes once the retried read has run; any earlier result needs more work. */
function evaluateAfter(execute: { mock: { results: { value: unknown }[] } }) {
  return async () => {
    const results = execute.mock.results;
    return results.length === 2 && (await results[1]?.value) === read
      ? {
          success: true,
          decision: "FINISH" as const,
          messageToUser: "12:00 to 12:30 PM is open.",
        }
      : { success: false, decision: "CONTINUE" as const };
  };
}

function historyCalls(messages: readonly ChatMessage[]) {
  return messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "tool-call" ? [part] : [],
        )
      : [],
  );
}

it("replays the declared scope so a retry after an argument rejection runs", async () => {
  let requests = 0;
  let replayed: unknown;
  const execute = vi.fn(async (call: { params?: Record<string, unknown> }) =>
    (call.params?.details as { timeMin?: unknown } | undefined)?.timeMin
      ? rejected
      : read,
  );
  await runPlannerLoop({
    context: { id: "scope-history-replay", events: [] },
    tools,
    runtime: {
      useModel: async (_type, params) => {
        requests++;
        if (requests === 1)
          return {
            text: "",
            toolCalls: [
              {
                id: "feed-1",
                name: "CALENDAR_FEED",
                arguments: {
                  details: { date: "2026-10-31", timeMin: "12:00" },
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        if (requests === 2) {
          // The model repeats its earlier call and corrects only the
          // rejected argument, as the live retries did.
          const previous = historyCalls(params.messages ?? []).at(-1);
          replayed = previous?.input;
          return {
            text: "",
            toolCalls: [
              {
                id: "feed-2",
                name: "CALENDAR_FEED",
                arguments: {
                  ...(previous?.input as Record<string, unknown>),
                  details: { date: "2026-10-31" },
                },
              },
            ],
          };
        }
        return finish;
      },
    },
    executeToolCall: execute,
    evaluate: evaluateAfter(execute),
  });
  expect(replayed).toEqual({
    details: { date: "2026-10-31", timeMin: "12:00" },
    eliza_turn_scope: "more_work_pending",
  });
  expect(execute).toHaveBeenCalledTimes(2);
  // Handlers still never receive the reserved argument.
  expect(execute.mock.calls[1]?.[0]).toMatchObject({
    name: "CALENDAR_FEED",
    params: { details: { date: "2026-10-31" } },
  });
  expect(JSON.stringify(execute.mock.calls[1]?.[0].params)).not.toContain(
    "eliza_turn_scope",
  );
});

it("leaves a missing scope unknown until the model explicitly chooses it", async () => {
  let requests = 0;
  let feedback: { expectedCalls?: unknown; rejectedModelOutput?: unknown } = {};
  const execute = vi.fn(async () => read);
  await runPlannerLoop({
    context: { id: "scope-rejection-feedback", events: [] },
    tools,
    runtime: {
      useModel: async (_type, params) => {
        requests++;
        if (requests === 1)
          return {
            text: "",
            toolCalls: [
              {
                id: "feed-1",
                name: "CALENDAR_FEED",
                arguments: {
                  details: { date: "2026-10-30" },
                  eliza_turn_scope: "more_work_pending",
                },
              },
            ],
          };
        const rejection = (params.messages ?? [])
          .map((message) =>
            typeof message.content === "string" ? message.content : "",
          )
          .findLast((content) =>
            content.includes("PLANNER_SCOPE_DECLARATION_REQUIRED"),
          );
        if (requests === 3 && rejection) {
          feedback = JSON.parse(rejection.slice(rejection.indexOf("{")));
          const [expected] = (feedback.expectedCalls ?? []) as {
            name: string;
            arguments: Record<string, unknown>;
          }[];
          if (expected)
            return {
              text: "",
              toolCalls: [
                {
                  id: "feed-3",
                  ...expected,
                  arguments: {
                    ...expected.arguments,
                    eliza_turn_scope: "final",
                  },
                },
              ],
            };
        }
        if (requests <= 3)
          return {
            text: "",
            toolCalls: [
              {
                id: `feed-${requests}`,
                name: "CALENDAR_FEED",
                arguments: { details: { date: "2026-10-31" } },
              },
            ],
          };
        return finish;
      },
    },
    executeToolCall: execute,
    evaluate: evaluateAfter(execute),
  });
  expect(feedback.expectedCalls).toEqual([
    {
      name: "CALENDAR_FEED",
      arguments: {
        details: { date: "2026-10-31" },
      },
    },
  ]);
  expect(feedback.rejectedModelOutput).toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls[1]?.[0]).toMatchObject({
    name: "CALENDAR_FEED",
    params: { details: { date: "2026-10-31" } },
  });
});

it("preserves known per-call scope without guessing another call's missing scope", async () => {
  let requests = 0;
  let feedback: { expectedCalls?: unknown } = {};
  const execute = vi.fn(async () => read);
  await expect(
    runPlannerLoop({
      context: { id: "mixed-scope-feedback", events: [] },
      tools,
      runtime: {
        useModel: async (_type, params) => {
          requests++;
          if (requests === 1)
            return {
              text: "",
              toolCalls: [
                {
                  id: "initial",
                  name: "CALENDAR_FEED",
                  arguments: {
                    details: { date: "2026-10-29" },
                    eliza_turn_scope: "more_work_pending",
                  },
                },
              ],
            };
          if (requests === 2)
            return {
              text: "",
              toolCalls: [
                {
                  id: "known",
                  name: "CALENDAR_FEED",
                  arguments: {
                    details: { date: "2026-10-30" },
                    eliza_turn_scope: "more_work_pending",
                  },
                },
                {
                  id: "missing",
                  name: "CALENDAR_FEED",
                  arguments: { details: { date: "2026-10-31" } },
                },
              ],
            };
          const rejection = (params.messages ?? [])
            .map((message) =>
              typeof message.content === "string" ? message.content : "",
            )
            .findLast((content) =>
              content.includes("PLANNER_SCOPE_DECLARATION_REQUIRED"),
            );
          if (!rejection)
            throw new Error("Expected missing-scope feedback before capture");
          feedback = JSON.parse(rejection.slice(rejection.indexOf("{")));
          throw new Error("Mixed scope feedback captured");
        },
      },
      executeToolCall: execute,
      evaluate: async () => ({ success: false, decision: "CONTINUE" as const }),
      config: { maxRepeatedFailures: 2, maxIterations: 5 },
    }),
  ).rejects.toThrow("Mixed scope feedback captured");
  expect(feedback.expectedCalls).toEqual([
    {
      name: "CALENDAR_FEED",
      arguments: {
        details: { date: "2026-10-30" },
        eliza_turn_scope: "more_work_pending",
      },
    },
    { name: "CALENDAR_FEED", arguments: { details: { date: "2026-10-31" } } },
  ]);
  // The entire mixed batch was rejected; no missing-scope call or settled
  // operation was replayed by this diagnostic feedback.
  expect(execute).toHaveBeenCalledTimes(1);
});
