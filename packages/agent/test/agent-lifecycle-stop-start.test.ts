import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
/** Route-level stop/start recovery for fully disposed agent runtimes. */
import type { AgentRuntime, UUID } from "@elizaos/core";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import {
  type AgentLifecycleRouteContext,
  type AgentLifecycleRouteState,
  handleAgentLifecycleRoutes,
} from "../src/api/agent-lifecycle-routes.ts";
import { startApiServer } from "../src/api/server.ts";
import { createServerResources } from "../src/api/server-resources.ts";

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

it("rejects pause and resume without a live runtime or during boot and teardown over HTTP", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-lifecycle-quint-"),
  );
  const apiToken = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_TOKEN: apiToken,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  const fixture = await createTestRuntime({ characterName: "Lifecycle model" });
  let releaseBoot!: () => void;
  let releaseRestart!: () => void;
  let releaseStop!: () => void;
  let observeBoot!: () => void;
  let observeRestart!: () => void;
  let observeStop!: () => void;
  const bootGate = new Promise<void>((resolve) => {
    releaseBoot = resolve;
  });
  const stopGate = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const restartGate = new Promise<void>((resolve) => {
    releaseRestart = resolve;
  });
  const bootEntered = new Promise<void>((resolve) => {
    observeBoot = resolve;
  });
  const stopEntered = new Promise<void>((resolve) => {
    observeStop = resolve;
  });
  const restartEntered = new Promise<void>((resolve) => {
    observeRestart = resolve;
  });
  let boots = 0;
  let stopped = false;
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    server = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
      onRestart: async () => {
        boots += 1;
        if (boots === 1) {
          observeBoot();
          await bootGate;
        } else {
          observeRestart();
          await restartGate;
        }
        return fixture.runtime;
      },
      onStop: async (runtime) => {
        expect(runtime).toBe(fixture.runtime);
        observeStop();
        await stopGate;
        await fixture.cleanup();
        stopped = true;
      },
    });
    const apiBase = `http://127.0.0.1:${server.port}`;
    const post = (action: string) =>
      fetch(`${apiBase}/api/agent/${action}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiToken}`,
          "content-type": "application/json",
        },
      });
    for (const action of ["pause", "resume"])
      expect((await post(action)).status).toBe(503);

    const starting = post("start");
    await Promise.race([
      bootEntered,
      starting.then(async (response) => {
        throw new Error(
          `Start returned before host boot: ${response.status} ${await response.text()}`,
        );
      }),
    ]);
    for (const action of ["pause", "resume", "restart"])
      expect((await post(action)).status).toBe(409);
    expect(await (await post("start")).json()).toMatchObject({
      status: { state: "starting" },
    });
    expect(boots).toBe(1);
    releaseBoot();
    expect((await starting).status).toBe(200);
    const restarting = post("restart");
    await Promise.race([
      restartEntered,
      restarting.then(async (response) => {
        throw new Error(
          `Restart returned before host restart: ${response.status} ${await response.text()}`,
        );
      }),
    ]);
    for (const action of ["pause", "resume", "stop", "restart"])
      expect((await post(action)).status).toBe(409);
    expect(await (await post("start")).json()).toMatchObject({
      status: { state: "restarting" },
    });
    // A start retry must preserve the restart fence for subsequent mutations.
    expect((await post("stop")).status).toBe(409);
    expect(boots).toBe(2);
    releaseRestart();
    expect((await restarting).status).toBe(200);
    expect((await post("pause")).status).toBe(200);
    expect((await post("resume")).status).toBe(200);

    const stopping = post("stop");
    await stopEntered;
    for (const action of ["pause", "resume", "start"])
      expect((await post(action)).status).toBe(409);
    releaseStop();
    expect(await (await stopping).json()).toMatchObject({
      status: { state: "stopped" },
    });
    expect((await post("resume")).status).toBe(503);
    expect(boots).toBe(2);
  } finally {
    releaseBoot();
    releaseRestart();
    releaseStop();
    if (server) await server.close();
    if (!stopped) await fixture.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("owns HTTP teardown before a disposer re-enters close", async () => {
  const listener = createServer((_req, res) => res.end("ready"));
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (!address || typeof address === "string")
    throw new Error("Missing listener port");
  const failures: unknown[] = [];
  const resources = createServerResources((_name, failure) =>
    failures.push(failure),
  );
  let calls = 0;
  let reentrantClose: Promise<void> | undefined;
  let rejectedRegistration = false;
  resources.add({
    name: "HTTP listener",
    async dispose() {
      calls += 1;
      if (calls === 1) reentrantClose = resources.close();
      try {
        resources.add({ name: "late resource", dispose() {} });
      } catch {
        rejectedRegistration = true;
      }
      await new Promise<void>((resolve, reject) =>
        listener.close((error) => (error ? reject(error) : resolve())),
      );
    },
  });
  try {
    expect(await (await fetch(`http://127.0.0.1:${address.port}`)).text()).toBe(
      "ready",
    );
    const closing = resources.close();
    expect(resources.close()).toBe(closing);
    await closing;
    expect(reentrantClose).toBe(closing);
    expect(calls).toBe(1);
    expect(rejectedRegistration).toBe(true);
    expect(failures).toEqual([]);
    expect(listener.listening).toBe(false);
  } finally {
    listener.closeAllConnections();
    if (listener.listening)
      await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
});
