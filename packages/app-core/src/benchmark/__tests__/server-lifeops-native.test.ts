import { describe, expect, it } from "vitest";
import {
  chooseLifeOpsNativeToolChoice,
  isBenchmarkServerEntrypoint,
  normalizeLifeOpsNativeMessages,
  normalizeLifeOpsNativePlannerResult,
} from "../server-utils.js";

describe("LifeOps native tool-call bridge", () => {
  it("builds native model messages with LifeOps context and user text", () => {
    const messages = normalizeLifeOpsNativeMessages("Schedule deep work.", {
      lifeops: {
        nowIso: "2026-05-10T12:00:00Z",
        calendarEvents: [{ id: "ev1", title: "Existing meeting" }],
      },
    });

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("LifeOpsBench"),
    });
    expect(messages[1]).toMatchObject({
      role: "system",
      content: expect.stringContaining("2026-05-10T12:00:00Z"),
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: "Schedule deep work.",
    });
  });

  it("replays previous LifeOps tool calls as native chat history", () => {
    const messages = normalizeLifeOpsNativeMessages(
      "archive thread_01464",
      {
        lifeops: {
          nowIso: "2026-05-10T12:00:00Z",
        },
      },
      [
        {
          userText: "archive thread_01464",
          assistantText: "",
          toolCalls: [
            {
              id: "call-message",
              name: "MESSAGE",
              arguments: {
                operation: "manage",
                manageOperation: "archive",
                threadId: "thread_01464",
              },
              ok: true,
              result: {
                thread_id: "thread_01464",
                archived_ids: ["email_002477"],
              },
            },
          ],
        },
      ],
    );

    expect(messages).toHaveLength(5);
    expect(messages[2]).toEqual({
      role: "user",
      content: "archive thread_01464",
    });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-message",
          type: "function",
          function: {
            name: "MESSAGE",
            arguments: expect.stringContaining("thread_01464"),
          },
        },
      ],
    });
    expect(messages[4]).toEqual({
      role: "tool",
      id: "call-message",
      name: "MESSAGE",
      content: JSON.stringify({
        thread_id: "thread_01464",
        archived_ids: ["email_002477"],
      }),
    });
  });

  it("maps AI SDK native toolCalls into handler-ready LifeOps tool calls", () => {
    const result = normalizeLifeOpsNativePlannerResult(
      {
        text: "",
        toolCalls: [
          {
            toolCallId: "call-calendar",
            toolName: "calendar.create_event",
            input: {
              calendar_id: "cal_primary",
              title: "deep work",
              start: "2026-05-11T14:00:00Z",
              end: "2026-05-11T14:30:00Z",
            },
          },
        ],
      },
      [
        {
          modelType: "TEXT_LARGE",
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      ],
    );

    expect(result).toEqual({
      text: "",
      toolCalls: [
        {
          id: "call-calendar",
          name: "calendar.create_event",
          arguments: {
            calendar_id: "cal_primary",
            title: "deep work",
            start: "2026-05-11T14:00:00Z",
            end: "2026-05-11T14:30:00Z",
          },
        },
      ],
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        cachedTokens: 0,
        cacheHitRatio: 0,
        callCount: 1,
        calls: [
          {
            modelType: "TEXT_LARGE",
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        ],
      },
    });
  });

  it("also accepts OpenAI-style snake_case tool_calls", () => {
    const result = normalizeLifeOpsNativePlannerResult({
      text: "",
      tool_calls: [
        {
          id: "call-message",
          type: "function",
          function: {
            name: "MESSAGE",
            arguments: JSON.stringify({
              operation: "triage",
              source: "gmail",
            }),
          },
        },
      ],
    });

    expect(result.toolCalls).toEqual([
      {
        id: "call-message",
        name: "MESSAGE",
        arguments: {
          operation: "triage",
          source: "gmail",
        },
      },
    ]);
  });

  it("requires a tool before any LifeOps tool result, then allows final prose", () => {
    expect(chooseLifeOpsNativeToolChoice()).toBe("required");
    expect(
      chooseLifeOpsNativeToolChoice([
        {
          userText: "archive thread_01464",
          assistantText: "",
          toolCalls: [],
        },
      ]),
    ).toBe("required");
    expect(
      chooseLifeOpsNativeToolChoice([
        {
          userText: "archive thread_01464",
          assistantText: "",
          toolCalls: [
            {
              id: "call-message",
              name: "MESSAGE",
              arguments: { operation: "manage" },
              ok: true,
              result: {},
            },
          ],
        },
      ]),
    ).toBe("auto");
  });
});

describe("benchmark server startup guard", () => {
  it("does not auto-start when imported by tests", () => {
    expect(
      isBenchmarkServerEntrypoint(
        "/repo/packages/app-core/src/benchmark/__tests__/server-lifeops-native.test.ts",
        "file:///repo/packages/app-core/src/benchmark/server.ts",
      ),
    ).toBe(false);
  });

  it("detects the package server entrypoint used by benchmark:server", () => {
    expect(
      isBenchmarkServerEntrypoint(
        "/repo/packages/app-core/src/benchmark/server.ts",
        "file:///repo/packages/app-core/src/benchmark/server.ts",
      ),
    ).toBe(true);
  });
});
