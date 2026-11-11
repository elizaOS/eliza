import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
/** Route-level stop/start recovery for fully disposed agent runtimes. */
import { type AgentRuntime, ChannelType, type UUID } from "@elizaos/core";
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

it("rejects competing lifecycle and wallet reloads during HTTP boot and teardown", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-lifecycle-quint-"),
  );
  const apiToken = randomUUID();
  await writeFile(
    path.join(directory, "eliza.json"),
    JSON.stringify({ wallet: { primary: { evm: "cloud" } } }),
  );
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_PERSIST_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_TOKEN: apiToken,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
    ENABLE_CLOUD_WALLET: "1",
  }))
    vi.stubEnv(key, value);
  vi.stubEnv("WALLET_SOURCE_EVM", undefined);
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
  let walletUpdate: Promise<Response> | undefined;
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
    expect(
      (
        await fetch(`${apiBase}/api/wallet/config`, {
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).status,
    ).toBe(200);

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
    let walletSettled = false;
    walletUpdate = fetch(`${apiBase}/api/wallet/primary`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ chain: "evm", source: "local" }),
    }).then((response) => {
      walletSettled = true;
      return response;
    });
    await vi.waitFor(() => expect(boots > 1 || walletSettled).toBe(true), {
      timeout: 30_000,
    });
    expect(boots).toBe(1);
    expect(await (await walletUpdate).json()).toMatchObject({
      ok: true,
      restarting: false,
    });
    expect(
      JSON.parse(await readFile(path.join(directory, "eliza.json"), "utf8")),
    ).toMatchObject({ wallet: { primary: { evm: "local" } } });
    expect(await (await post("start")).json()).toMatchObject({
      status: { state: "starting" },
    });
    releaseBoot();
    expect((await starting).status).toBe(200);
    const readStatus = async () =>
      (
        await fetch(`${apiBase}/api/status`, {
          headers: { authorization: `Bearer ${apiToken}` },
        })
      ).json();
    expect(await readStatus()).toMatchObject({
      state: "running",
      pendingRestart: true,
      pendingRestartReasons: ["Wallet configuration updated"],
    });
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
    expect(await readStatus()).toMatchObject({
      state: "running",
      pendingRestart: false,
      pendingRestartReasons: [],
    });
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
    await Promise.allSettled([walletUpdate]);
    if (server) await server.close();
    if (!stopped) await fixture.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

it("retains paused ownership after failed builds and drains admitted work before HTTP replacement", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "agent-replacement-quint-"),
  );
  const apiToken = randomUUID();
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: path.join(directory, "eliza.json"),
    ELIZA_API_TOKEN: apiToken,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  const first = await createTestRuntime({ characterName: "Outgoing owner" });
  const second = await createTestRuntime({
    characterName: "Replacement owner",
  });
  const roomId = randomUUID() as UUID;
  const worldId = randomUUID() as UUID;
  let releaseTurn!: () => void;
  let enteredTurn!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    enteredTurn = resolve;
  });
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let active: Promise<void> | undefined;
  let cancelled: Promise<unknown> | undefined;
  let restarting: Promise<Response> | undefined;
  const controller = new AbortController();
  let builds = 0;
  let queuedEntered = false;
  let activationCount = 0;
  try {
    await first.runtime.createWorld({
      id: worldId,
      agentId: first.runtime.agentId,
      name: "Replacement drain",
    });
    await first.runtime.createRoom({
      id: roomId,
      agentId: first.runtime.agentId,
      name: "Before admitted turn",
      source: "test",
      type: ChannelType.DM,
      worldId,
    });
    server = await startApiServer({
      port: 0,
      runtime: first.runtime,
      skipDeferredStartupWork: true,
      onRestart: async () => {
        builds += 1;
        if (builds === 1) return null;
        if (builds === 2) throw new Error("Replacement build failed");
        return second.runtime;
      },
      onRuntimeActivated: async (outgoing, replacement) => {
        expect(outgoing).toBe(first.runtime);
        expect(replacement).toBe(second.runtime);
        expect(first.runtime.roomHandlerQueue.pendingTotal()).toBe(0);
        expect((await first.runtime.getRoom(roomId))?.name).toBe(
          "Admitted turn committed",
        );
        activationCount += 1;
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const headers = { authorization: `Bearer ${apiToken}` };
    const post = (action: string) =>
      fetch(`${base}/api/agent/${action}`, { method: "POST", headers });
    const status = async () =>
      (await fetch(`${base}/api/status`, { headers })).json();

    expect((await post("pause")).status).toBe(200);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect((await post("restart")).status).toBe(500);
      expect(await status()).toMatchObject({
        state: "paused",
        agentName: "Outgoing owner",
      });
      expect(first.runtime.roomHandlerQueue.isAcceptingAdmissions()).toBe(true);
      expect(activationCount).toBe(0);
    }
    expect((await post("resume")).status).toBe(200);
    active = first.runtime.roomHandlerQueue.runWith(
      roomId,
      async () => {
        enteredTurn();
        await gate;
        // Abort only removes queued work. The admitted callback must commit and
        // release ownership before the server can publish the new runtime.
        await first.runtime.updateRoom({
          id: roomId,
          name: "Admitted turn committed",
          source: "test",
          type: ChannelType.DM,
        });
      },
      { signal: controller.signal },
    );
    await entered;
    cancelled = first.runtime.roomHandlerQueue
      .runWith(
        roomId,
        async () => {
          queuedEntered = true;
          await first.runtime.updateRoom({
            id: roomId,
            name: "Cancelled callback ran",
            source: "test",
            type: ChannelType.DM,
          });
        },
        { signal: controller.signal },
      )
      .catch((error: unknown) => error);
    expect(first.runtime.roomHandlerQueue.pendingTotal()).toBe(2);
    restarting = post("restart");
    await vi.waitFor(() => {
      expect(first.runtime.roomHandlerQueue.isAcceptingAdmissions()).toBe(
        false,
      );
    });
    controller.abort(new Error("Cancel queued turn while replacement waits"));
    expect(await cancelled).toMatchObject({
      name: "RoomHandlerQueueAbortedError",
    });
    expect(first.runtime.roomHandlerQueue.pendingTotal()).toBe(1);
    expect(queuedEntered).toBe(false);
    expect(activationCount).toBe(0);
    expect(await status()).toMatchObject({
      state: "restarting",
      agentName: "Outgoing owner",
    });
    for (const action of ["pause", "resume", "stop", "restart"])
      expect((await post(action)).status).toBe(409);
    expect(await (await post("start")).json()).toMatchObject({
      status: { state: "restarting" },
    });
    await expect(
      first.runtime.roomHandlerQueue.runWith(roomId, async () => {
        throw new Error("Closed admission ran a callback");
      }),
    ).rejects.toMatchObject({ code: "ROOM_HANDLER_QUEUE_CLOSED" });

    releaseTurn();
    await active;
    expect((await restarting).status).toBe(200);
    expect(activationCount).toBe(1);
    expect(builds).toBe(3);
    expect(queuedEntered).toBe(false);
    expect(await status()).toMatchObject({
      state: "running",
      agentName: "Replacement owner",
    });
    expect(first.runtime.roomHandlerQueue.isAcceptingAdmissions()).toBe(false);
    expect(
      await second.runtime.roomHandlerQueue.runWith(
        roomId,
        async () => "new owner",
      ),
    ).toBe("new owner");
  } finally {
    releaseTurn();
    controller.abort();
    await Promise.allSettled([active, cancelled, restarting]);
    if (server) await server.close();
    await first.cleanup();
    await second.cleanup();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

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
