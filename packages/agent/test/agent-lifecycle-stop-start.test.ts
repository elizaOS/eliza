/** Route-level stop/start recovery for fully disposed agent runtimes. */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import {
  type AgentLifecycleRouteContext,
  type AgentLifecycleRouteState,
  handleAgentLifecycleRoutes,
} from "../src/api/agent-lifecycle-routes.ts";

function createRuntime(name: string): AgentRuntime {
  return {
    character: { name, settings: { model: "fixture-model" } },
  } as unknown as AgentRuntime;
}

function createState(runtime: AgentRuntime): AgentLifecycleRouteState {
  return {
    runtime,
    agentState: "running",
    agentName: runtime.character.name ?? "Eliza",
    model: "fixture-model",
    startedAt: Date.now(),
    chatConnectionReady: {
      userId: "00000000-0000-0000-0000-000000000001" as UUID,
      roomId: "00000000-0000-0000-0000-000000000002" as UUID,
      worldId: "00000000-0000-0000-0000-000000000003" as UUID,
    },
    chatConnectionPromise: Promise.resolve(),
    runtimeStopPromise: null,
  };
}

function createRouteHarness(args: {
  runtime: AgentRuntime;
  replacement: AgentRuntime;
  stopError?: Error;
}) {
  const state = createState(args.runtime);
  const responses: Array<{ status: number; body: unknown }> = [];
  const onStop = vi.fn(async () => {
    if (args.stopError) throw args.stopError;
  });
  const onRestart = vi.fn(async () => args.replacement);

  const dispatch = async (pathname: string) => {
    const handled = await handleAgentLifecycleRoutes({
      req: {},
      res: {},
      method: "POST",
      pathname,
      state,
      onStop,
      onRestart,
      error: (_res: unknown, message: string, status: number) => {
        responses.push({ status, body: { error: message } });
      },
      json: (_res: unknown, body: unknown, status = 200) => {
        responses.push({ status, body });
      },
      readJsonBody: async () => ({}),
    } as unknown as AgentLifecycleRouteContext);
    expect(handled).toBe(true);
    return responses.at(-1);
  };

  return { dispatch, onRestart, onStop, state };
}

it("boots a new runtime after a successful stop", async () => {
  const stopped = createRuntime("Stopped");
  const replacement = createRuntime("Replacement");
  const harness = createRouteHarness({ runtime: stopped, replacement });

  expect(await harness.dispatch("/api/agent/stop")).toMatchObject({
    status: 200,
    body: { status: { state: "stopped" } },
  });
  expect(harness.onStop).toHaveBeenCalledWith(stopped);
  expect(harness.state.runtime).toBeNull();

  expect(await harness.dispatch("/api/agent/start")).toMatchObject({
    status: 200,
    body: { status: { state: "running", agentName: "Replacement" } },
  });
  expect(harness.onRestart).toHaveBeenCalledOnce();
  expect(harness.state.runtime).toBe(replacement);
});

it("boots a new runtime after teardown reports a failure", async () => {
  const stopped = createRuntime("Stopped");
  const replacement = createRuntime("Recovered");
  const harness = createRouteHarness({
    runtime: stopped,
    replacement,
    stopError: new Error("adapter close failed"),
  });

  expect(await harness.dispatch("/api/agent/stop")).toEqual({
    status: 500,
    body: { error: "Agent stop failed: adapter close failed" },
  });
  expect(harness.state.runtime).toBeNull();
  expect(harness.state.chatConnectionReady).toBeNull();
  expect(harness.state.chatConnectionPromise).toBeNull();

  expect(await harness.dispatch("/api/agent/start")).toMatchObject({
    status: 200,
    body: { status: { state: "running", agentName: "Recovered" } },
  });
  expect(harness.onRestart).toHaveBeenCalledOnce();
  expect(harness.state.runtime).toBe(replacement);
});
