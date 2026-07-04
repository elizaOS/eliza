/**
 * Built-apps registry: a successful app-deploy completion must produce a
 * durable registry record with the verified live URL.
 *
 * Before this module existed, apps the agent built from chat were
 * fire-and-forget — the router verified the live URL at `task_complete` and
 * persisted only screenshot/trajectory artifacts, so nothing could ever list
 * the app again (no `registerBuiltApp` anywhere in the repo).
 *
 * Covers:
 *  1. pure derivation for both deploy targets (custom static host URL-shape
 *     match; eliza-cloud app-build gate + code-host/loopback exclusion);
 *  2. registry round-trip + redeploy dedupe on the runtime cache;
 *  3. the REAL router path: handleEvent("task_complete") with a live URL
 *     served by a local HTTP server → verification probes it → the registry
 *     record lands in the runtime cache with that URL.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeGrillingRuntime } from "../../test/scenarios/_helpers/orchestrator-grilling-harness.ts";
import { makeSpawnCapturingAcp } from "../../test/scenarios/_helpers/reflexion-scenario.ts";
import {
  BUILT_APPS_CACHE_KEY,
  type BuiltAppRecord,
  deriveBuiltApp,
  listBuiltApps,
  registerBuiltApp,
  registerBuiltAppsForCompletion,
} from "../services/built-apps-registry.ts";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.ts";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.ts";
import { SubAgentRouter } from "../services/sub-agent-router.ts";

const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MSG = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "00000000-0000-4000-8000-000000000001";

const CUSTOM_CONFIG = {
  target: "custom" as const,
  customAppsDir: "/srv/apps",
  customBaseUrl: "https://example.org",
};

function record(overrides: Partial<BuiltAppRecord> = {}): BuiltAppRecord {
  return {
    slug: "snake-game",
    name: "Snake Game",
    url: "https://example.org/apps/snake-game/",
    target: "custom",
    sessionId: "sess-1",
    registeredAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function cacheRuntime(): {
  runtime: IAgentRuntime;
  cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const runtime = {
    getCache: async (key: string) => cache.get(key),
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
  } as unknown as IAgentRuntime;
  return { runtime, cache };
}

describe("deriveBuiltApp (custom static host)", () => {
  it("derives slug + name from a verified URL under <base>/apps/<slug>/", () => {
    const derived = deriveBuiltApp(
      ["https://example.org/apps/snake-game/"],
      CUSTOM_CONFIG,
    );
    expect(derived).toEqual({
      slug: "snake-game",
      name: "Snake Game",
      url: "https://example.org/apps/snake-game/",
      target: "custom",
    });
  });

  it("matches a deep entry URL (index.html) to the same slug", () => {
    const derived = deriveBuiltApp(
      ["https://example.org/apps/todo/index.html"],
      CUSTOM_CONFIG,
    );
    expect(derived?.slug).toBe("todo");
  });

  it("ignores verified URLs outside the configured apps base", () => {
    expect(
      deriveBuiltApp(
        ["https://example.org/docs/guide/", "https://other.host/apps/x/"],
        CUSTOM_CONFIG,
      ),
    ).toBeNull();
  });
});

describe("deriveBuiltApp (eliza-cloud)", () => {
  const CLOUD = { target: "eliza-cloud" as const };
  const APP_TASK = "build a website for tracking my workouts and deploy it";

  it("requires the app-build gate: a non-app task registers nothing", () => {
    expect(
      deriveBuiltApp(
        ["https://myapp.elizacloud.example/"],
        CLOUD,
        "fix the failing unit test in packages/core",
      ),
    ).toBeNull();
    expect(
      deriveBuiltApp(["https://myapp.elizacloud.example/"], CLOUD),
    ).toBeNull();
  });

  it("skips code-host and loopback URLs, registers the hosted app URL", () => {
    const derived = deriveBuiltApp(
      [
        "https://github.com/acme/workouts/pull/12",
        "http://127.0.0.1:3000/",
        "https://workouts.apps.elizacloud.example/",
      ],
      CLOUD,
      APP_TASK,
    );
    expect(derived).toEqual({
      slug: "workouts",
      name: "Workouts",
      url: "https://workouts.apps.elizacloud.example/",
      target: "eliza-cloud",
    });
  });
});

describe("registry round-trip", () => {
  it("registers, lists, and dedupes a redeploy by target+slug", async () => {
    const { runtime } = cacheRuntime();
    expect(await listBuiltApps(runtime)).toEqual([]);

    await registerBuiltApp(runtime, record());
    await registerBuiltApp(runtime, record({ slug: "todo", name: "Todo" }));
    expect(await listBuiltApps(runtime)).toHaveLength(2);

    // Redeploy of the same app: refreshed record replaces, not duplicates.
    const redeploy = record({
      sessionId: "sess-2",
      registeredAt: new Date(1000).toISOString(),
    });
    await registerBuiltApp(runtime, redeploy);
    const apps = await listBuiltApps(runtime);
    expect(apps).toHaveLength(2);
    expect(apps[0]).toEqual(redeploy);
  });

  it("degrades gracefully when the runtime has no cache", async () => {
    const bare = {} as IAgentRuntime;
    expect(await registerBuiltApp(bare, record())).toBe(false);
    expect(await listBuiltApps(bare)).toEqual([]);
    expect(
      await registerBuiltAppsForCompletion(bare, { id: "s" }, [
        "https://example.org/apps/x/",
      ]),
    ).toBeNull();
  });
});

describe("durable-task spawn path (#12036 follow-up)", () => {
  // The durable-task route stamps `goal` (not `initialTask`) on session
  // metadata, so the register handoff must gate the eliza-cloud target on
  // either key — otherwise an app built via a durable task never registers.
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = ["ELIZA_CONFIG_PATH", "ELIZA_APP_DEPLOY_TARGET"];

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.ELIZA_CONFIG_PATH = "/nonexistent/built-apps-test.json";
    process.env.ELIZA_APP_DEPLOY_TARGET = "eliza-cloud";
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("a spawnAgentForTask session carries the task text and its cloud deploy registers", async () => {
    const goal = "build a website for tracking my workouts and deploy it";
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const detail = await store.createTask({
      title: "Workout tracker",
      goal,
      acceptanceCriteria: [],
      roomId: ROOM,
      taskRoomId: ROOM,
      worldId: "scenario-world",
    });
    const acp = makeSpawnCapturingAcp();
    const base = {
      agentId: AGENT_ID,
      character: { name: "Tester" },
      databaseAdapter: undefined,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      getSetting: () => undefined,
      getService: () => undefined,
      useModel: async () => "{}",
    } as unknown as IAgentRuntime;
    const service = new OrchestratorTaskService(
      makeGrillingRuntime(base, acp.service, async () => "{}"),
      { store },
    );
    await service.start();
    try {
      await service.spawnAgentForTask(detail.task.id);
    } finally {
      await service.stop().catch(() => undefined);
    }

    // The durable spawn persists the bare goal on session metadata (the same
    // key the direct-API spawn stamps)…
    const spawned = acp.spawns.at(0);
    expect(spawned?.metadata?.goal).toBe(goal);

    // …and the SAME register handoff the router runs at task_complete gates
    // the eliza-cloud target on it: the durable-built app lands in the
    // registry exactly like a chat-spawned one.
    const { runtime, cache } = cacheRuntime();
    const registered = await registerBuiltAppsForCompletion(
      runtime,
      { id: spawned?.sessionId ?? "", metadata: spawned?.metadata },
      ["https://workouts.apps.elizacloud.example/"],
    );
    expect(registered).toMatchObject({
      slug: "workouts",
      target: "eliza-cloud",
      url: "https://workouts.apps.elizacloud.example/",
    });
    expect(cache.get(BUILT_APPS_CACHE_KEY)).toHaveLength(1);
  });
});

describe("task_complete → registry record (real router path)", () => {
  let server: Server;
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "ELIZA_CONFIG_PATH",
    "ELIZA_APP_DEPLOY_TARGET",
    "ELIZA_APP_DEPLOY_CUSTOM_APPS_DIR",
    "ELIZA_APP_DEPLOY_CUSTOM_BASE_URL",
    "ELIZA_URL_VERIFY_SETTLE_MS",
  ];

  beforeEach(async () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>snake</body></html>");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // Hermetic config: no config file, custom static host via env.
    process.env.ELIZA_CONFIG_PATH = "/nonexistent/built-apps-test.json";
    process.env.ELIZA_APP_DEPLOY_TARGET = "custom";
    process.env.ELIZA_APP_DEPLOY_CUSTOM_APPS_DIR = "/srv/apps";
    process.env.ELIZA_APP_DEPLOY_CUSTOM_BASE_URL = baseUrl;
    process.env.ELIZA_URL_VERIFY_SETTLE_MS = "0";
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  function routerHarness(session: { id: string } & Record<string, unknown>): {
    cache: Map<string, unknown>;
    runtime: IAgentRuntime;
  } {
    const cache = new Map<string, unknown>();
    const sessions = new Map<string, Record<string, unknown>>([
      [session.id, session],
    ]);
    const acp = {
      onSessionEvent: () => () => {},
      getSession: async (id: string) => sessions.get(id),
      getSessions: async () => [...sessions.values()],
      getChangedPaths: () => [] as string[],
      spawnSession: vi.fn(async () => ({ sessionId: "retry-1" })),
      stopSession: vi.fn(async () => undefined),
      updateSessionMetadata: vi.fn(async () => undefined),
    };
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Tester" },
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getSetting: (key: string) => process.env[key],
      getService: (type: string) =>
        type === "ACP_SERVICE" || type === "ACP_SUBPROCESS_SERVICE"
          ? acp
          : undefined,
      getCache: async (key: string) => cache.get(key),
      setCache: async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      },
      createEntity: vi.fn(async () => true),
      addParticipant: vi.fn(async () => true),
      createMemory: vi.fn(async () => MSG),
      emitEvent: vi.fn(async () => undefined),
      useModel: vi.fn(async () => "{}"),
    } as unknown as IAgentRuntime;
    return { cache, runtime };
  }

  async function driveTaskComplete(
    runtime: IAgentRuntime,
    sessionId: string,
    response: string,
  ): Promise<void> {
    const router = new SubAgentRouter(runtime);
    await router.start();
    const internals = router as unknown as {
      handleEvent(id: string, event: string, data: unknown): Promise<void>;
    };
    await internals.handleEvent(sessionId, "task_complete", {
      response,
      stopReason: "end_turn",
    });
    await router.stop();
  }

  it("a successful app-deploy completion writes the live URL to the registry", async () => {
    const liveUrl = `${baseUrl}/apps/snake-game/`;
    const { cache, runtime } = routerHarness({
      id: "sess-app",
      agentType: "codex",
      name: "Ada",
      workdir: "/tmp/built-apps-registry-test",
      status: "ready",
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      metadata: {
        roomId: ROOM,
        taskRoomId: ROOM,
        messageId: MSG,
        source: "discord",
        label: "build snake game",
        initialTask: "build a snake game web app and deploy it live",
      },
    });

    await driveTaskComplete(
      runtime,
      "sess-app",
      `The snake game is built and live at ${liveUrl}`,
    );

    const apps = cache.get(BUILT_APPS_CACHE_KEY) as BuiltAppRecord[];
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      slug: "snake-game",
      name: "Snake Game",
      url: liveUrl,
      target: "custom",
      sessionId: "sess-app",
      label: "build snake game",
    });
    expect(apps[0].registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("a room-less durable task's deploy still registers (cockpit new-session / bare API create)", async () => {
    const liveUrl = `${baseUrl}/apps/workout-tracker/`;
    // Exactly what spawnAgentForTask stamps for a task created WITHOUT a chat
    // room (cockpit "new session", bare POST /api/orchestrator/tasks): no room
    // UUID anywhere, the bare `goal` (not `initialTask`), source
    // "orchestrator". readOrigin() yields null for this session, so the router
    // has no room to post to — the registry write must not depend on one.
    const { cache, runtime } = routerHarness({
      id: "sess-roomless",
      agentType: "codex",
      name: "Ada",
      workdir: "/tmp/built-apps-registry-test",
      status: "ready",
      createdAt: new Date(0),
      lastActivityAt: new Date(0),
      metadata: {
        taskId: "task-1",
        roomId: undefined,
        label: "Ada",
        source: "orchestrator",
        goal: "build a workout tracker web app and deploy it live",
        keepAliveAfterComplete: true,
        nestingDepth: 0,
      },
    });

    await driveTaskComplete(
      runtime,
      "sess-roomless",
      `Deployed. The workout tracker is live at ${liveUrl}`,
    );

    const apps = cache.get(BUILT_APPS_CACHE_KEY) as BuiltAppRecord[];
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      slug: "workout-tracker",
      name: "Workout Tracker",
      url: liveUrl,
      target: "custom",
      sessionId: "sess-roomless",
      label: "Ada",
    });
  });
});
