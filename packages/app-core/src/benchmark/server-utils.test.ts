import { describe, expect, it } from "vitest";
import { coerceParams } from "./params";
import {
  clearCapturedAction,
  createBenchmarkPlugin,
  getCapturedActions,
  setBenchmarkContext,
} from "./plugin";
import {
  benchmarkTurnMetadata,
  capturedActionsToToolCalls,
  composeBenchmarkPrompt,
  normalizeBenchmarkModelUsage,
  summarizeBenchmarkTurnUsage,
} from "./server-utils";

const uuid = (value: string) =>
  value as unknown as import("@elizaos/core").UUID;

describe("coerceParams", () => {
  it("returns object params as-is", () => {
    expect(
      coerceParams({ BENCHMARK_ACTION: { command: "search[laptop]" } }),
    ).toEqual({
      BENCHMARK_ACTION: { command: "search[laptop]" },
    });
  });

  it("parses JSON object strings", () => {
    expect(
      coerceParams(
        '{"BENCHMARK_ACTION":{"tool_name":"lookup","arguments":{}}}',
      ),
    ).toEqual({
      BENCHMARK_ACTION: { tool_name: "lookup", arguments: {} },
    });
  });

  it("does not parse non-JSON key-value text", () => {
    expect(
      coerceParams("BENCHMARK_ACTION:\n  command: search[laptop]"),
    ).toEqual({});
  });
});

describe("benchmark function-call metadata", () => {
  it("normalizes captured benchmark actions to native tool_calls", () => {
    expect(
      capturedActionsToToolCalls([
        {
          toolName: "mail.search",
          arguments: { query: "from:boss", limit: 5 },
          params: {
            tool_name: "mail.search",
            arguments: { query: "from:boss", limit: 5 },
          },
        },
      ]),
    ).toEqual([
      {
        id: "call_benchmark_0",
        type: "function",
        function: {
          name: "mail.search",
          arguments: '{"limit":5,"query":"from:boss"}',
        },
      },
    ]);
  });

  it("builds Eliza-only trajectory metadata with tool schema counts", () => {
    const metadata = benchmarkTurnMetadata({
      session: {
        benchmark: "loca_bench",
        taskId: "task-a",
        roomId: uuid("00000000-0000-0000-0000-000000000001"),
        relayRoomId: uuid("00000000-0000-0000-0000-000000000002"),
        userEntityId: uuid("00000000-0000-0000-0000-000000000003"),
      },
      step: 2,
      nativeTrajectoryStepId: "native-step-2",
      context: {
        tools: [
          {
            type: "function",
            function: { name: "calendar.search", parameters: {} },
          },
        ],
      },
    });

    expect(metadata.agent_label).toBe("eliza");
    expect(metadata.trajectory_step).toBe(2);
    expect(metadata.native_trajectory_step_id).toBe("native-step-2");
    expect(metadata.tool_schema_count).toBe(1);
    expect(metadata.tool_names).toEqual(["calendar.search"]);
    expect(metadata.trajectory_endpoint).toContain("loca_bench");
  });
});

describe("benchmark MODEL_USED cache telemetry", () => {
  it("normalizes cache read and creation token fields from MODEL_USED payloads", () => {
    expect(
      normalizeBenchmarkModelUsage({
        type: "TEXT_LARGE",
        provider: "anthropic",
        source: "anthropic",
        tokens: {
          prompt: 120,
          completion: 30,
          total: 150,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 12,
        },
      }),
    ).toEqual({
      modelType: "TEXT_LARGE",
      provider: "anthropic",
      source: "anthropic",
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      cachedTokens: 80,
      cacheReadInputTokens: 80,
      cacheCreationInputTokens: 12,
    });
  });

  it("accepts legacy cacheRead/cacheWrite aliases from MODEL_USED payloads", () => {
    expect(
      normalizeBenchmarkModelUsage({
        type: "TEXT_SMALL",
        source: "anthropic",
        tokens: {
          prompt: 10,
          completion: 2,
          total: 12,
          cacheRead: 6,
          cacheWrite: 4,
        },
      }),
    ).toEqual({
      modelType: "TEXT_SMALL",
      provider: "anthropic",
      source: "anthropic",
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
      cachedTokens: 6,
      cacheReadInputTokens: 6,
      cacheCreationInputTokens: 4,
    });
  });

  it("preserves cache read and creation totals in per-turn usage JSON", () => {
    expect(
      summarizeBenchmarkTurnUsage([
        {
          modelType: "TEXT_LARGE",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedTokens: 60,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 8,
        },
        {
          modelType: "TEXT_LARGE",
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50,
          cachedTokens: 15,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 2,
        },
      ]),
    ).toEqual({
      promptTokens: 140,
      completionTokens: 30,
      totalTokens: 170,
      cachedTokens: 75,
      cacheReadInputTokens: 75,
      cacheCreationInputTokens: 10,
      cacheHitRatio: 75 / 140,
      callCount: 2,
      calls: [
        {
          modelType: "TEXT_LARGE",
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
          cachedTokens: 60,
          cacheReadInputTokens: 60,
          cacheCreationInputTokens: 8,
        },
        {
          modelType: "TEXT_LARGE",
          promptTokens: 40,
          completionTokens: 10,
          totalTokens: 50,
          cachedTokens: 15,
          cacheReadInputTokens: 15,
          cacheCreationInputTokens: 2,
        },
      ],
    });
  });
});

describe("composeBenchmarkPrompt", () => {
  it("compacts LOCA context before injecting it into the user prompt", () => {
    const prompt = composeBenchmarkPrompt({
      text: "Finish the CSV files.",
      context: {
        benchmark: "loca_bench",
        task_id: "task-a",
        taskId: "task-a",
        session_id: "session-a",
        messages: [
          {
            role: "assistant",
            content: "prior assistant text that should not be duplicated",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "filesystem_list_directory",
              parameters: { type: "object" },
            },
          },
        ],
        temperature: 1,
        top_p: 1,
      },
    });

    expect(prompt).toContain('"tool_names"');
    expect(prompt).toContain("filesystem_list_directory");
    expect(prompt).toContain("LOCA-bench");
    expect(prompt).toContain("BENCHMARK_ACTION");
    expect(prompt).toContain("source_data is read-only");
    expect(prompt).toContain("assignment_info.csv");
    expect(prompt).not.toContain("prior assistant text");
    expect(prompt).not.toContain('"messages"');
  });
});

describe("benchmark plugin LOCA tool capture", () => {
  it("scopes LOCA MCP tool shims and captures direct tool-name calls", async () => {
    clearCapturedAction();
    setBenchmarkContext(null);
    const plugin = createBenchmarkPlugin();
    const action = plugin.actions?.find(
      (candidate) => candidate.name === "filesystem_list_directory_with_sizes",
    );
    const canvasAction = plugin.actions?.find(
      (candidate) => candidate.name === "canvas_canvas_list_assignments",
    );

    expect(action).toBeDefined();
    expect(canvasAction).toBeDefined();
    expect(action?.allowAdditionalParameters).toBe(true);
    expect(canvasAction?.allowAdditionalParameters).toBe(true);
    expect(action?.suppressPostActionContinuation).toBe(true);
    expect(canvasAction?.suppressPostActionContinuation).toBe(true);
    expect(
      action?.parameters?.some((parameter) => parameter.name === "path"),
    ).toBe(true);
    expect(
      canvasAction?.parameters?.some(
        (parameter) => parameter.name === "course_id",
      ),
    ).toBe(true);
    expect(
      await action?.validate?.({} as never, {} as never, {} as never),
    ).toBe(false);
    expect(
      await canvasAction?.validate?.({} as never, {} as never, {} as never),
    ).toBe(false);

    setBenchmarkContext({
      benchmark: "loca_bench",
      taskId: "task-a",
    });

    expect(
      await action?.validate?.({} as never, {} as never, {} as never),
    ).toBe(true);
    expect(
      await canvasAction?.validate?.({} as never, {} as never, {} as never),
    ).toBe(true);

    await action?.handler(
      {} as never,
      {} as never,
      {} as never,
      {
        actionContext: { previousResults: [] },
        path: ".",
        sortBy: "size",
      } as never,
    );

    expect(getCapturedActions()).toEqual([
      {
        params: { path: ".", sortBy: "size" },
        toolName: "filesystem_list_directory_with_sizes",
        arguments: { path: ".", sortBy: "size" },
      },
    ]);

    clearCapturedAction();
    setBenchmarkContext(null);
  });
});

describe("benchmark plugin LifeOps tool capture", () => {
  it("renders LifeOpsBench access and routing instructions", async () => {
    setBenchmarkContext({
      benchmark: "lifeops_bench",
      taskId: "lifeops-task-prompt",
      lifeops: {
        nowIso: "2026-05-10T12:00:00Z",
        today: "2026-05-10",
        calendarEvents: [],
        previousToolResults: [],
      },
      tools: [
        {
          type: "function",
          function: {
            name: "CALENDAR_CHECK_AVAILABILITY",
            description: "calendar availability",
            parameters: {},
          },
        },
        {
          type: "function",
          function: {
            name: "MESSAGE",
            description: "message manage",
            parameters: {},
          },
        },
      ],
    });

    const plugin = createBenchmarkPlugin();
    const provider = plugin.providers?.find(
      (candidate) => candidate.name === "ELIZA_BENCHMARK",
    );
    const rendered = await provider?.get?.(
      {} as never,
      {} as never,
      {} as never,
    );

    expect(rendered?.text).toContain(
      "You have access to the benchmark's fake LifeOps calendar and inbox",
    );
    expect(rendered?.text).toContain("CALENDAR_CHECK_AVAILABILITY");
    expect(rendered?.text).toContain(
      "MEMORY is not a LifeOpsBench executor tool",
    );
    expect(rendered?.text).toContain("ARCHIVE_THREAD with threadId");

    setBenchmarkContext(null);
  });

  it("accepts planner-emitted fields and strips runtime action context", async () => {
    clearCapturedAction();
    setBenchmarkContext({
      benchmark: "lifeops_bench",
      taskId: "lifeops-task-a",
    });

    const plugin = createBenchmarkPlugin();
    const action = plugin.actions?.find(
      (candidate) => candidate.name === "CALENDAR_CHECK_AVAILABILITY",
    );

    expect(action).toBeDefined();
    expect(action?.allowAdditionalParameters).toBe(true);
    expect(action?.suppressPostActionContinuation).toBe(true);
    expect(
      action?.parameters?.some((parameter) => parameter.name === "startAt"),
    ).toBe(true);

    await action?.handler(
      {} as never,
      {} as never,
      {} as never,
      {
        actionContext: { previousResults: [] },
        action: "check_availability",
        intent: "Check if I am free Thursday 9-10am UTC",
        details: {
          start: "2026-05-14T09:00:00Z",
          end: "2026-05-14T10:00:00Z",
        },
      } as never,
    );

    expect(getCapturedActions()).toEqual([
      {
        params: {
          action: "check_availability",
          intent: "Check if I am free Thursday 9-10am UTC",
          details: {
            start: "2026-05-14T09:00:00Z",
            end: "2026-05-14T10:00:00Z",
          },
        },
        toolName: "CALENDAR_CHECK_AVAILABILITY",
        arguments: {
          action: "check_availability",
          intent: "Check if I am free Thursday 9-10am UTC",
          details: {
            start: "2026-05-14T09:00:00Z",
            end: "2026-05-14T10:00:00Z",
          },
        },
      },
    ]);

    clearCapturedAction();
    setBenchmarkContext(null);
  });

  it("exposes the LifeOps MESSAGE umbrella for mail scenarios", async () => {
    clearCapturedAction();
    setBenchmarkContext({
      benchmark: "lifeops_bench",
      taskId: "lifeops-task-b",
    });

    const plugin = createBenchmarkPlugin();
    const action = plugin.actions?.find(
      (candidate) => candidate.name === "MESSAGE",
    );

    expect(action).toBeDefined();
    expect(action?.allowAdditionalParameters).toBe(true);
    expect(
      action?.parameters?.some((parameter) => parameter.name === "threadId"),
    ).toBe(true);

    await action?.handler(
      {} as never,
      {} as never,
      {} as never,
      {
        actionContext: { previousResults: [] },
        operation: "manage",
        source: "gmail",
        manageOperation: "archive",
        threadId: "thread_01464",
      } as never,
    );

    expect(getCapturedActions()).toEqual([
      {
        params: {
          operation: "manage",
          source: "gmail",
          manageOperation: "archive",
          threadId: "thread_01464",
        },
        toolName: "MESSAGE",
        arguments: {
          operation: "manage",
          source: "gmail",
          manageOperation: "archive",
          threadId: "thread_01464",
        },
      },
    ]);

    clearCapturedAction();
    setBenchmarkContext(null);
  });

  it("exposes archive thread aliases for mail scenarios", async () => {
    clearCapturedAction();
    setBenchmarkContext({
      benchmark: "lifeops_bench",
      taskId: "lifeops-task-c",
    });

    const plugin = createBenchmarkPlugin();
    const action = plugin.actions?.find(
      (candidate) => candidate.name === "ARCHIVE_THREAD",
    );

    expect(action).toBeDefined();
    expect(action?.allowAdditionalParameters).toBe(true);
    expect(action?.description).toContain("email archive alias");
    expect(
      action?.parameters?.some((parameter) => parameter.name === "threadId"),
    ).toBe(true);

    await action?.handler(
      {} as never,
      {} as never,
      {} as never,
      {
        actionContext: { previousResults: [] },
        threadId: "thread_01464",
      } as never,
    );

    expect(getCapturedActions()).toEqual([
      {
        params: {
          threadId: "thread_01464",
        },
        toolName: "ARCHIVE_THREAD",
        arguments: {
          threadId: "thread_01464",
        },
      },
    ]);

    clearCapturedAction();
    setBenchmarkContext(null);
  });
});
