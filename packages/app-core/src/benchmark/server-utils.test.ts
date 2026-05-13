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
