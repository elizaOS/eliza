import {
  runWithLlmInputSubstringAttestation,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coerceParams } from "./params";
import {
  clearCapturedAction,
  createBenchmarkPlugin,
  getBenchmarkContext,
  getCapturedActions,
  runWithBenchmarkContext,
  setBenchmarkContext,
} from "./plugin";
import {
  benchmarkRuntimeActionNames,
  benchmarkTurnMetadata,
  capturedActionsToToolCalls,
  composeBenchmarkPrompt,
  configureBenchmarkToolCallPolicy,
  hasLifecycleTaskAction,
  normalizeBenchmarkModelUsage,
  parseTrajectoryStepQuery,
  selectTrajectoryOutbox,
  selectTrajectorySteps,
  summarizeBenchmarkTurnUsage,
} from "./server-utils";

const uuid = (value: string) => stringToUuid(value);

afterEach(() => {
  setBenchmarkContext(null);
  vi.unstubAllEnvs();
});

describe("request-scoped benchmark context", () => {
  it("does not install context when hint attestation rejects before dispatch", async () => {
    const nativeTurn = vi.fn(() =>
      runWithBenchmarkContext(
        { benchmark: "orchestrator_lifecycle", taskId: "invalid-hint" },
        async () => "unreachable",
      ),
    );

    await expect(
      runWithLlmInputSubstringAttestation("", nativeTurn),
    ).rejects.toMatchObject({
      code: "LLM_INPUT_SUBSTRING_ATTESTATION_INVALID",
    });
    expect(nativeTurn).not.toHaveBeenCalled();
    expect(getBenchmarkContext()).toBeNull();
  });

  it("clears rejected turn context before the next request runs", async () => {
    const rejectedContext = {
      benchmark: "orchestrator_lifecycle",
      taskId: "rejected-turn",
    };

    await expect(
      runWithBenchmarkContext(rejectedContext, async () => {
        expect(getBenchmarkContext()).toBe(rejectedContext);
        throw new Error("model-boundary attestation rejected the turn");
      }),
    ).rejects.toThrow("model-boundary attestation rejected the turn");
    expect(getBenchmarkContext()).toBeNull();

    const nextContext = { benchmark: "standard", taskId: "next-turn" };
    await runWithBenchmarkContext(nextContext, async () => {
      expect(getBenchmarkContext()).toBe(nextContext);
    });
    expect(getBenchmarkContext()).toBeNull();
  });
});

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

describe("trajectory step selection", () => {
  const steps = [{ step: 1 }, { step: 2 }, { step: 3 }];

  it("preserves the full session when step is omitted", () => {
    expect(parseTrajectoryStepQuery(null)).toEqual({ ok: true, value: null });
    expect(
      selectTrajectorySteps(steps, null).map((entry) => entry.step),
    ).toEqual([1, 2, 3]);
  });

  it("selects exactly the requested turn", () => {
    expect(parseTrajectoryStepQuery("2")).toEqual({ ok: true, value: 2 });
    expect(selectTrajectorySteps(steps, 2).map((entry) => entry.step)).toEqual([
      2,
    ]);
  });

  it("selects only outbox entries emitted during the requested turn", () => {
    const selected = [{ step: 2, startedAt: 200, finishedAt: 299 }];
    const outbox = [
      {
        kind: "direct" as const,
        targetId: "a",
        text: "one",
        source: "test",
        ts: 150,
      },
      {
        kind: "direct" as const,
        targetId: "a",
        text: "two",
        source: "test",
        ts: 250,
      },
      {
        kind: "direct" as const,
        targetId: "a",
        text: "three",
        source: "test",
        ts: 350,
      },
    ];

    expect(selectTrajectoryOutbox(outbox, selected, 2)).toEqual([outbox[1]]);
    expect(selectTrajectoryOutbox(outbox, selected, null)).toEqual(outbox);
  });

  it.each(["", "0", "-1", "1.5", " 2", "9007199254740992"])(
    "rejects invalid step %j",
    (raw) => {
      expect(parseTrajectoryStepQuery(raw)).toMatchObject({
        ok: false,
        code: "BENCHMARK_TRAJECTORY_STEP_INVALID",
      });
    },
  );
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
    vi.stubEnv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", "");
    vi.stubEnv("ELIZA_BENCH_SKIP_EMBEDDING", "");
    vi.stubEnv("ELIZA_BENCH_MOCK", "");
    vi.stubEnv("ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY", "");
    vi.stubEnv("ELIZA_BENCH_COMPACTION_THRESHOLD_TOKENS", "");
    vi.stubEnv("CONTEXT_COMPACTION_THRESHOLD_TOKENS", "");
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
      nativeRuntimeApi: "useModel",
      toolBridge: "runtime_model_native_tools",
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
    expect(metadata.native_runtime_class).toBe("@elizaos/core.AgentRuntime");
    expect(metadata.native_runtime_api).toBe("useModel");
    expect(metadata.transport).toBe("eliza_benchmark_http");
    expect(metadata.tool_bridge).toBe("runtime_model_native_tools");
    expect(metadata.direct_model_bypass).toBe(false);
    expect(metadata.stand_in).toBe(false);
    expect(metadata.release_evidence).toBe(true);
    expect(metadata.embedding_mode).toBe("runtime-provider");
    expect(metadata.semantic_memory_enabled).toBe(true);
    expect(metadata.compaction_threshold_tokens).toBeNull();
    expect(metadata.trajectory_step).toBe(2);
    expect(metadata.native_trajectory_step_id).toBe("native-step-2");
    expect(metadata.tool_schema_count).toBe(1);
    expect(metadata.tool_names).toEqual(["calendar.search"]);
    expect(metadata.lifecycle_task_action_registered).toBe(false);
    expect(metadata.lifecycle_system_hint_attestation).toBeNull();
    expect(metadata.trajectory_endpoint).toContain("loca_bench");
  });

  it("proves the native TASKS action inventory for lifecycle metadata", () => {
    const runtime = {
      actions: [
        { name: "REPLY" },
        { name: "TASKS" },
        { name: "TASKS_LIST_AGENTS" },
      ],
    };

    expect(benchmarkRuntimeActionNames(runtime)).toEqual([
      "REPLY",
      "TASKS",
      "TASKS_LIST_AGENTS",
    ]);
    expect(hasLifecycleTaskAction(runtime)).toBe(true);
    expect(hasLifecycleTaskAction({ actions: [{ name: "REPLY" }] })).toBe(
      false,
    );
  });

  it("records subscription text-only memory without marking a stand-in", () => {
    vi.stubEnv("ELIZA_BENCH_ALLOW_STUB_EMBEDDING", "0");
    vi.stubEnv("ELIZA_BENCH_SKIP_EMBEDDING", "0");
    vi.stubEnv("ELIZA_BENCH_MOCK", "");
    vi.stubEnv("ELIZA_BENCH_SUBSCRIPTION_CHAT_ONLY", "1");

    const metadata = benchmarkTurnMetadata({
      session: {
        benchmark: "orchestrator_lifecycle",
        taskId: "lifecycle-a",
        roomId: uuid("00000000-0000-0000-0000-000000000001"),
        relayRoomId: uuid("00000000-0000-0000-0000-000000000002"),
        userEntityId: uuid("00000000-0000-0000-0000-000000000003"),
      },
      step: 2,
      nativeRuntimeApi: "messageService.handleMessage",
      toolBridge: "native_action_capture",
      lifecycleSystemHintAttestation: {
        schemaVersion: 1,
        expectedSha256: "a".repeat(64),
        modelCallCount: 3,
        matchingCallCount: 3,
        totalOccurrences: 3,
        exactOncePerModelCall: true,
        modelTypeCallCounts: {
          ACTION_PLANNER: 1,
          RESPONSE_HANDLER: 2,
        },
      },
    });

    expect(metadata.stand_in).toBe(false);
    expect(metadata.release_evidence).toBe(true);
    expect(metadata.embedding_mode).toBe("disabled-text-only");
    expect(metadata.semantic_memory_enabled).toBe(false);
    expect(metadata.lifecycle_system_hint_attestation).toEqual({
      schema_version: 1,
      system_hint_sha256: "a".repeat(64),
      model_boundary_call_count: 3,
      model_boundary_attested_call_count: 3,
      model_boundary_hint_occurrence_count: 3,
      exact_once_per_model_call: true,
      model_type_call_counts: {
        ACTION_PLANNER: 1,
        RESPONSE_HANDLER: 2,
      },
    });
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

  it("keeps a context-less message byte-for-byte clean (identity-only context)", () => {
    // normalizeBenchmarkContext stamps benchmark/taskId/task_id onto every
    // message, so a client that sent NO context still arrives here with the
    // identity trio. Decorating such a message with the authoritative-context
    // JSON + action-output trailer corrupted the user's actual ask: the
    // acceptance-gate smoke "Reply with the single word: PONG" stopped parsing
    // as a say-literal request in core and dead-ended in the unusable-reply
    // deferral.
    const prompt = composeBenchmarkPrompt({
      text: "Reply with the single word: PONG",
      context: {
        benchmark: "unknown",
        taskId: "default-task",
        task_id: "default-task",
      },
    });
    expect(prompt).toBe("Reply with the single word: PONG");
  });

  it("still decorates a message whose context carries real task payload", () => {
    const prompt = composeBenchmarkPrompt({
      text: "List the directory.",
      context: {
        benchmark: "agentbench",
        taskId: "task-1",
        task_id: "task-1",
        goal: "explore the filesystem",
        action_space: ["ls", "cd"],
      },
    });
    expect(prompt).toContain("BENCHMARK CONTEXT (authoritative):");
    expect(prompt).toContain('"goal": "explore the filesystem"');
    expect(prompt).toContain(
      "Respond using normal Eliza action output so actions/params can be executed and evaluated.",
    );
  });

  it("keeps the image payload even when the context is identity-only", () => {
    const prompt = composeBenchmarkPrompt({
      text: "What is in this screenshot?",
      context: { benchmark: "unknown", taskId: "t", task_id: "t" },
      image: { url: "data:image/png;base64,AAAA" },
    });
    expect(prompt).toContain("IMAGE PAYLOAD:");
    expect(prompt).toContain("data:image/png;base64,AAAA");
  });

  it("keeps lifecycle user text clean and delegates the shared hint to its provider", () => {
    const hint =
      "Manage delegated work with the available task action and report its result truthfully.";
    const prompt = composeBenchmarkPrompt({
      text: "The current approach failed. Replan and continue.",
      context: {
        benchmark: "orchestrator_lifecycle",
        task_id: "lifecycle-a",
        model_name: "claude-sonnet-4-6",
        system_hint: hint,
      },
    });

    expect(prompt).toBe("The current approach failed. Replan and continue.");
    expect(prompt).not.toContain(hint);
    expect(prompt).not.toContain("orchestrator_lifecycle");
    expect(prompt).not.toContain("lifecycle-a");
    expect(prompt).not.toContain("claude-sonnet-4-6");
  });

  it("disables forced tools for lifecycle while preserving other benchmark defaults", () => {
    vi.stubEnv("ELIZA_BENCH_FORCE_TOOL_CALL", "1");
    configureBenchmarkToolCallPolicy(true);
    expect(process.env.ELIZA_BENCH_FORCE_TOOL_CALL).toBe("0");

    vi.stubEnv("ELIZA_BENCH_FORCE_TOOL_CALL", "");
    delete process.env.ELIZA_BENCH_FORCE_TOOL_CALL;
    configureBenchmarkToolCallPolicy(false);
    expect(process.env.ELIZA_BENCH_FORCE_TOOL_CALL).toBe("1");
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

  it("renders only neutral shared orchestrator lifecycle guidance", async () => {
    const systemHint =
      "Manage delegated work with the available task action and report its result truthfully.";
    setBenchmarkContext({
      benchmark: "orchestrator_lifecycle",
      taskId: "lifecycle-a",
      model_name: "claude-sonnet-sensitive",
      scenario_id: "scenario-sensitive",
      system_hint: systemHint,
      expected_behaviors: ["ack_scope_change", "apply_scope_change_to_task"],
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

    expect(rendered?.text).toBe(systemHint);
    expect(rendered?.text).not.toContain("orchestrator_lifecycle");
    expect(rendered?.text).not.toContain("lifecycle-a");
    expect(rendered?.text).not.toContain("expected_behaviors");
    expect(rendered?.values).toEqual({});
    expect(rendered?.data).toEqual({});
    expect(JSON.stringify(rendered)).not.toMatch(
      /orchestrator_lifecycle|lifecycle-a|claude-sonnet|scenario-|expected_behaviors|ack_scope_change|apply_scope_change_to_task/,
    );

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
