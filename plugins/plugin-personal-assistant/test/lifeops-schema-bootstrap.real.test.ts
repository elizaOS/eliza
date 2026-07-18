/**
 * Real-PGlite regressions for the registry-only LifeOps schema bootstrap and
 * its composition with runtime-owned pendant-session data.
 */

import type http from "node:http";
import { elizaPluginSchema } from "@elizaos/agent/runtime/eliza-schema";
import type { AgentRuntime, Plugin } from "@elizaos/core";
import {
  type NativeWebsiteBlockerBackend,
  registerNativeWebsiteBlockerBackend,
  type SelfControlPermissionState,
  type SelfControlStatus,
} from "@elizaos/plugin-blocker/services/website-blocker/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { executeRawSql } from "../src/lifeops/sql.ts";
import { registerPersonalAssistantRuntimeHooks } from "../src/register-runtime.ts";
import type { LifeOpsRouteContext } from "../src/routes/lifeops-routes.ts";
import { personalAssistantRoutesPlugin } from "../src/routes/plugin.ts";
import { handleSleepRoutes } from "../src/routes/sleep-routes.ts";
import { hasActiveHarshNoBypassRule } from "../src/website-blocker/chat-integration/harsh-mode-check.ts";

const runtimeSchemaPlugin: Plugin = {
  name: "eliza",
  description: "Runtime-owned schema used by the production Eliza agent.",
  schema: elizaPluginSchema,
};

function createSleepHistoryContext(runtime: AgentRuntime): {
  ctx: LifeOpsRouteContext;
  response: { body: unknown; error: string | null; status: number | null };
} {
  const url = new URL("http://localhost/api/lifeops/sleep/history");
  const response: {
    body: unknown;
    error: string | null;
    status: number | null;
  } = { body: null, error: null, status: null };
  const res = { statusCode: 200 } as http.ServerResponse;
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: url.pathname,
      url,
      state: { runtime, adminEntityId: null },
      json: (_res, body, status = 200) => {
        response.body = body;
        response.status = status;
      },
      error: (_res, message, status = 500) => {
        response.error = message;
        response.status = status;
      },
      readJsonBody: async () => null,
      decodePathComponent: (raw) => raw,
    },
    response,
  };
}

async function invokeRegisteredGetRoute(
  runtime: AgentRuntime,
  routePath: string,
  requestUrl = routePath,
): Promise<{ body: unknown; error: string | null; status: number | null }> {
  const response: {
    body: unknown;
    error: string | null;
    status: number | null;
  } = { body: null, error: null, status: null };
  const req = {
    method: "GET",
    url: requestUrl,
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  } as http.IncomingMessage;
  const res = {
    statusCode: 200,
    setHeader: () => res,
    end: (chunk?: unknown) => {
      response.status = res.statusCode;
      if (chunk !== undefined) {
        response.body = JSON.parse(String(chunk));
        if (
          response.body &&
          typeof response.body === "object" &&
          "error" in response.body
        ) {
          response.error = String(response.body.error);
        }
      }
      return res;
    },
  } as http.ServerResponse;
  const route = personalAssistantRoutesPlugin.routes?.find(
    (candidate) => candidate.type === "GET" && candidate.path === routePath,
  );
  if (!route?.handler) {
    throw new Error(`Missing registered GET route: ${routePath}`);
  }
  await route.handler(req as never, res as never, runtime as never);
  return response;
}

function installSafeWebsiteBlockerBackend(): void {
  const status: SelfControlStatus = {
    available: true,
    active: true,
    hostsFilePath: null,
    startedAt: null,
    endsAt: null,
    websites: ["x.com"],
    blockedWebsites: ["x.com"],
    allowedWebsites: [],
    requestedWebsites: ["x.com"],
    matchMode: "exact",
    managedBy: null,
    metadata: null,
    scheduledByAgentId: null,
    canUnblockEarly: true,
    requiresElevation: false,
    engine: "content-blocker",
    platform: "ios",
    supportsElevationPrompt: false,
    elevationPromptMethod: null,
  };
  const permission: SelfControlPermissionState = {
    id: "website-blocking",
    status: "granted",
    lastChecked: 0,
    canRequest: false,
  };
  const backend: NativeWebsiteBlockerBackend = {
    getStatus: async () => status,
    startBlock: async () => ({ success: true, endsAt: null }),
    stopBlock: async () => ({ success: true, removed: false, status }),
    getPermissionState: async () => permission,
    requestPermission: async () => permission,
  };
  registerNativeWebsiteBlockerBackend(backend);
}

async function listRouteTableNames(runtime: AgentRuntime): Promise<string[]> {
  return (
    await executeRawSql(
      runtime,
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'app_lifeops'
          AND table_name IN ('life_block_rules', 'life_sleep_episodes')
        ORDER BY table_name`,
    )
  ).map((row) => String(row.table_name));
}

describe("LifeOps schema bootstrap", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("serves the first route-only sleep read before the runtime hook runs", async () => {
    runtimeResult = await createRealTestRuntime({
      characterName: "lifeops-route-only-sleep-bootstrap",
      plugins: [runtimeSchemaPlugin],
    });
    const { runtime } = runtimeResult;
    await expect(listRouteTableNames(runtime)).resolves.toEqual([]);

    const { ctx, response } = createSleepHistoryContext(runtime);
    await expect(handleSleepRoutes(ctx)).resolves.toBe(true);
    await expect(listRouteTableNames(runtime)).resolves.toEqual([
      "life_block_rules",
      "life_sleep_episodes",
    ]);
    expect(response).toEqual({
      body: {
        episodes: [],
        summary: {
          cycleCount: 0,
          averageDurationMin: null,
          overnightCount: 0,
          napCount: 0,
          openCount: 0,
        },
        windowDays: 365,
        includeNaps: false,
      },
      error: null,
      status: 200,
    });
  }, 180_000);

  it("serves the first database-backed website-blocker request before the runtime hook runs", async () => {
    runtimeResult = await createRealTestRuntime({
      characterName: "lifeops-route-only-website-blocker-bootstrap",
      plugins: [runtimeSchemaPlugin],
    });
    const { runtime } = runtimeResult;
    await expect(listRouteTableNames(runtime)).resolves.toEqual([]);

    // A process-local native backend keeps this route proof away from the
    // developer's real hosts file while the PGlite boundary remains real.
    installSafeWebsiteBlockerBackend();
    const response = await invokeRegisteredGetRoute(
      runtime,
      "/api/website-blocker",
      "/api/website-blocker?host=x.com",
    );
    await expect(listRouteTableNames(runtime)).resolves.toEqual([
      "life_block_rules",
      "life_sleep_episodes",
    ]);
    expect(response.error).toBeNull();
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      blocked: true,
      host: "x.com",
      groupKey: null,
      requiredTasks: [],
      websites: ["x.com"],
    });
  }, 180_000);

  it("serves goals and todos through the route-only plugin on a fresh database", async () => {
    runtimeResult = await createRealTestRuntime({
      characterName: "lifeops-route-only-goals-todos-bootstrap",
      plugins: [runtimeSchemaPlugin],
    });
    const { runtime } = runtimeResult;
    await expect(listRouteTableNames(runtime)).resolves.toEqual([]);

    await expect(
      invokeRegisteredGetRoute(runtime, "/api/lifeops/goals"),
    ).resolves.toEqual({ body: { goals: [] }, error: null, status: 200 });
    await expect(
      invokeRegisteredGetRoute(runtime, "/api/lifeops/todos"),
    ).resolves.toEqual({ body: { todos: [] }, error: null, status: 200 });
    await expect(listRouteTableNames(runtime)).resolves.toEqual([
      "life_block_rules",
      "life_sleep_episodes",
    ]);
  }, 180_000);

  it("shares one migration between concurrent runtime hooks and route requests", async () => {
    runtimeResult = await createRealTestRuntime({
      characterName: "lifeops-route-only-hook-bootstrap",
      plugins: [runtimeSchemaPlugin],
    });
    const { runtime } = runtimeResult;
    await expect(listRouteTableNames(runtime)).resolves.toEqual([]);
    const adapter = runtime.adapter;
    if (!adapter || typeof adapter.runPluginMigrations !== "function") {
      throw new Error("real runtime did not provide a migration adapter");
    }
    const runPluginMigrations = vi.spyOn(adapter, "runPluginMigrations");

    // Registry hooks can be discovered while an early dashboard request is in
    // flight; every boundary must converge on the same per-runtime migration.
    const [, , goalsResponse] = await Promise.all([
      registerPersonalAssistantRuntimeHooks(runtime),
      registerPersonalAssistantRuntimeHooks(runtime),
      invokeRegisteredGetRoute(runtime, "/api/lifeops/goals"),
    ]);

    expect(goalsResponse).toEqual({
      body: { goals: [] },
      error: null,
      status: 200,
    });
    expect(runPluginMigrations).toHaveBeenCalledOnce();
    await expect(listRouteTableNames(runtime)).resolves.toEqual([
      "life_block_rules",
      "life_sleep_episodes",
    ]);
    await expect(hasActiveHarshNoBypassRule(runtime)).resolves.toBe(false);
  }, 180_000);

  it("preserves every pendant table and its existing rows", async () => {
    runtimeResult = await createRealTestRuntime({
      characterName: "lifeops-schema-bootstrap",
      plugins: [runtimeSchemaPlugin],
    });
    const { runtime } = runtimeResult;

    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.pendant_sessions (
         id, owner_id, agent_id, started_at, state, processing_location,
         created_at, updated_at
       ) VALUES (
         'sentinel-session', 'sentinel-owner', 'sentinel-agent',
         '2026-07-20T19:30:00.000Z', 'active', 'local',
         '2026-07-20T19:30:00.000Z', '2026-07-20T19:30:00.000Z'
       )`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.pendant_session_segments (
         id, session_id, owner_id, agent_id, ordinal, status, text,
         started_at, created_at, updated_at
       ) VALUES (
         'sentinel-segment', 'sentinel-session', 'sentinel-owner',
         'sentinel-agent', 0, 'final', 'Preserve this transcript.',
         '2026-07-20T19:30:00.000Z', '2026-07-20T19:30:00.000Z',
         '2026-07-20T19:30:00.000Z'
       )`,
    );
    await executeRawSql(
      runtime,
      `INSERT INTO app_lifeops.pendant_session_insight_refs (
         id, session_id, owner_id, agent_id, segment_ids_json,
         created_at, updated_at
       ) VALUES (
         'sentinel-insight', 'sentinel-session', 'sentinel-owner',
         'sentinel-agent', '["sentinel-segment"]',
         '2026-07-20T19:30:00.000Z', '2026-07-20T19:30:00.000Z'
       )`,
    );

    const previousAllowDestructive =
      process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;
    process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS = "true";
    try {
      await LifeOpsRepository.bootstrapSchema(runtime);
    } finally {
      if (previousAllowDestructive === undefined) {
        delete process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS;
      } else {
        process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS =
          previousAllowDestructive;
      }
    }

    const tables = await executeRawSql(
      runtime,
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'app_lifeops'
          AND table_name LIKE 'pendant%'
        ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      "pendant_session_insight_refs",
      "pendant_session_segments",
      "pendant_sessions",
    ]);

    await expect(
      executeRawSql(
        runtime,
        `SELECT id, owner_id, agent_id
           FROM app_lifeops.pendant_sessions
          WHERE id = 'sentinel-session'`,
      ),
    ).resolves.toEqual([
      {
        id: "sentinel-session",
        owner_id: "sentinel-owner",
        agent_id: "sentinel-agent",
      },
    ]);

    await expect(
      executeRawSql(
        runtime,
        `SELECT id, session_id, text
           FROM app_lifeops.pendant_session_segments
          WHERE id = 'sentinel-segment'`,
      ),
    ).resolves.toEqual([
      {
        id: "sentinel-segment",
        session_id: "sentinel-session",
        text: "Preserve this transcript.",
      },
    ]);

    await expect(
      executeRawSql(
        runtime,
        `SELECT id, session_id, segment_ids_json
           FROM app_lifeops.pendant_session_insight_refs
          WHERE id = 'sentinel-insight'`,
      ),
    ).resolves.toEqual([
      {
        id: "sentinel-insight",
        session_id: "sentinel-session",
        segment_ids_json: '["sentinel-segment"]',
      },
    ]);
  }, 180_000);
});
