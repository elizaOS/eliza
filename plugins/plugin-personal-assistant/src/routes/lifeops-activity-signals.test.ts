/**
 * End-to-end proof of the LifeOps activity-signal ingestion path against a real
 * PGlite-backed AgentRuntime: an HTTP-shaped POST to
 * /api/lifeops/activity-signals travels the real route dispatcher →
 * LifeOpsService → RemindersDomain normalization → LifeOpsRepository insert,
 * and the domain artifact (a row in app_lifeops.life_activity_signals plus the
 * telemetry mirror) is read back both through GET and straight from the
 * database. Also covers the error path: invalid input is a 400, never a
 * fabricated row. No mocks — real runtime, real migrations, real SQL.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import {
  AgentRuntime,
  type Character,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import {
  createSchedulingSqlScheduledTaskStore,
  type ScheduledTask,
  SchedulingMigrationService,
} from "@elizaos/plugin-scheduling";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgliteDatabaseAdapter } from "../../../plugin-sql/src/pglite/adapter.js";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import * as runtimeSchema from "../../../plugin-sql/src/schema/index.js";
import type { CaptureLifeOpsActivitySignalRequest } from "../contracts/index.js";
import {
  activateLifeOpsActivitySignals,
  deactivateLifeOpsActivitySignals,
} from "../lifeops/activity-signal-lifecycle.js";
import { getSignalSourceRegistry } from "../lifeops/registries/signal-source-registry.js";
import { LifeOpsRepository } from "../lifeops/repository.js";
import {
  DOSSIER_ACTIVITY_ANCHOR_KEY,
  readDossierActivityState,
} from "../lifeops/scheduled-task/dossier-activity-policy.js";
import { createDossierActivityMutationPolicy } from "../lifeops/scheduled-task/dossier-activity-runtime.js";
import {
  handleLifeOpsRoutes,
  type LifeOpsRouteContext,
} from "./lifeops-routes.js";

interface CapturedResponse {
  statusCode?: number;
  body?: string;
  ended: boolean;
}

function buildCtx(args: {
  method: string;
  pathname: string;
  runtime: AgentRuntime;
  body?: unknown;
  search?: string;
}): { ctx: LifeOpsRouteContext; res: CapturedResponse } {
  const res: CapturedResponse = { ended: false };
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  const httpReq = new IncomingMessage(socket);
  httpReq.method = args.method;
  httpReq.headers = args.body
    ? { "content-type": "application/json", "content-length": "1" }
    : {};

  const httpRes = new ServerResponse(httpReq);
  httpRes.statusCode = 0;
  httpRes.end = function end(
    this: ServerResponse,
    chunk?: unknown,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): ServerResponse {
    res.ended = true;
    res.body = typeof chunk === "string" ? chunk : "";
    res.statusCode = this.statusCode;
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return this;
  };

  const ctx: LifeOpsRouteContext = {
    req: httpReq,
    res: httpRes,
    method: args.method,
    pathname: args.pathname,
    url: new URL(`http://localhost${args.pathname}${args.search ?? ""}`),
    state: { runtime: args.runtime, adminEntityId: null },
    json(r, data, status = 200) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify(data));
    },
    error(r, message, status = 400) {
      r.statusCode = status;
      r.setHeader?.("content-type", "application/json");
      r.end?.(JSON.stringify({ error: message }));
    },
    async readJsonBody<T extends object>(): Promise<T | null> {
      return (args.body as T | undefined) ?? null;
    },
    decodePathComponent(raw) {
      try {
        return decodeURIComponent(raw);
      } catch {
        // error-policy:J3 an undecodable path component is invalid input,
        // reported as null exactly like the production decoder.
        return null;
      }
    },
  };
  return { ctx, res };
}

describe("activity-signal ingestion e2e (real runtime + PGlite)", () => {
  let agentId: UUID;
  let manager: PGliteClientManager;
  let adapter: PgliteDatabaseAdapter;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    agentId = crypto.randomUUID() as UUID;
    manager = new PGliteClientManager({});
    await manager.initialize();
    adapter = new PgliteDatabaseAdapter(agentId, manager);
    await adapter.init();
    runtime = new AgentRuntime({
      agentId,
      character: { name: "lifeops-activity-e2e" } as Character,
      adapter,
    });
    activateLifeOpsActivitySignals(runtime);
  });

  afterEach(async () => {
    deactivateLifeOpsActivitySignals(runtime);
    await adapter.close();
    await manager.close();
  });

  it("admits authenticated foreground and explicit Android unlock events using server time, never passive snapshots", async () => {
    await adapter.runPluginMigrations([
      { name: "@elizaos/plugin-sql", schema: runtimeSchema },
    ]);
    await LifeOpsRepository.bootstrapSchema(runtime);
    await SchedulingMigrationService.start(runtime);
    const store = createSchedulingSqlScheduledTaskStore({ runtime, agentId });
    const ownerId = crypto.randomUUID() as UUID;
    const seed: ScheduledTask = {
      taskId: crypto.randomUUID(),
      kind: "recap",
      promptInstructions: "Prepare the daily dossier",
      source: "first_run",
      idempotencyKey: "lifeops:first-run:default:morning-brief",
      trigger: {
        kind: "relative_to_anchor",
        anchorKey: DOSSIER_ACTIVITY_ANCHOR_KEY,
        offsetMinutes: 0,
      },
      state: { status: "scheduled", followupCount: 0 },
      priority: "medium",
      respectsGlobalPause: true,
      createdBy: "agent",
      ownerVisible: true,
    };
    const prepare = createDossierActivityMutationPolicy({
      ownerFacts: () => ({ timezone: "UTC" }),
    });
    const initialized = await prepare({
      previous: null,
      proposed: seed,
      verb: "schedule",
      nowIso: new Date(Date.now() - 60_000).toISOString(),
    });
    if (!initialized)
      throw new Error("Expected managed dossier initialization");
    await store.upsert(initialized);

    const post = (
      principal: LifeOpsRouteContext["state"]["authenticatedPrincipal"],
      state = "active",
      overrides: Partial<CaptureLifeOpsActivitySignalRequest> = {},
    ) => {
      const request = buildCtx({
        method: "POST",
        pathname: "/api/lifeops/activity-signals",
        runtime,
        body: {
          source: "page_visibility",
          platform: "web_app",
          state,
          observedAt: "2000-01-01T00:00:00.000Z",
          metadata: {
            principalId: ownerId,
            receivedAtIso: "2099-01-01T00:00:00Z",
          },
          ...overrides,
        },
      });
      request.ctx.state.adminEntityId = ownerId;
      request.ctx.state.requestEntityId = ownerId;
      request.ctx.state.authenticatedPrincipal = principal;
      return request;
    };
    const owner = {
      kind: "owner" as const,
      entityId: ownerId,
      authIdentityId: "verified-owner-session",
    };
    const androidUnlock: Partial<CaptureLifeOpsActivitySignalRequest> = {
      source: "mobile_device",
      platform: "android",
      state: "active",
      idleState: "active",
      metadata: {
        reason: "broadcast:android.intent.action.USER_PRESENT",
        isDeviceLocked: false,
        isInteractive: true,
      },
    };
    const passive: Partial<CaptureLifeOpsActivitySignalRequest>[] = [
      ...[
        "start",
        "snapshot",
        "broadcast:android.intent.action.SCREEN_ON",
        "broadcast:android.intent.action.SCREEN_OFF",
        "broadcast:android.intent.action.BATTERY_CHANGED",
        "broadcast:android.os.action.POWER_SAVE_MODE_CHANGED",
      ].map((reason) => ({
        ...androidUnlock,
        metadata: { ...androidUnlock.metadata, reason },
      })),
      { ...androidUnlock, platform: "ios" },
      { ...androidUnlock, platform: "web" },
      { ...androidUnlock, state: "locked" },
      { ...androidUnlock, state: "sleeping" },
      { ...androidUnlock, idleState: "locked" },
      {
        ...androidUnlock,
        metadata: { ...androidUnlock.metadata, isDeviceLocked: true },
      },
      {
        ...androidUnlock,
        metadata: { ...androidUnlock.metadata, isInteractive: false },
      },
      {
        ...androidUnlock,
        metadata: { reason: androidUnlock.metadata?.reason },
      },
      {
        source: "mobile_device",
        platform: "ios",
        state: "active",
        idleState: "active",
        metadata: { reason: "start" },
      },
      {
        source: "desktop_power",
        state: "active",
        idleState: "active",
        metadata: {},
      },
      {
        source: "desktop_power",
        state: "active",
        idleState: "active",
        metadata: { windowFocused: false, documentVisibility: "visible" },
      },
      {
        source: "desktop_power",
        state: "active",
        idleState: "active",
        metadata: { windowFocused: true, documentVisibility: "hidden" },
      },
    ];
    // This inner-route harness supplies the wrapper's typed principal. These
    // reads prove fallback IDs and client metadata cannot replace that input.
    for (const request of [
      post(undefined),
      post({
        kind: "guest",
        entityId: ownerId,
        authIdentityId: "guest-session",
      }),
      post(owner, "background"),
      post(undefined, "active", androidUnlock),
      ...passive.map((signal) => post(owner, "active", signal)),
    ]) {
      expect(await handleLifeOpsRoutes(request.ctx)).toBe(true);
      expect(request.res.statusCode).toBe(201);
      expect(
        readDossierActivityState((await store.get(seed.taskId))?.metadata)
          ?.admitted,
      ).toBeNull();
    }

    for (const positive of [
      {},
      { source: "app_lifecycle" },
      {
        source: "desktop_power",
        state: "active",
        idleState: "active",
        metadata: { windowFocused: true, documentVisibility: "visible" },
      },
      androidUnlock,
      {
        ...androidUnlock,
        state: "idle",
        idleState: "idle",
        metadata: { ...androidUnlock.metadata, isPowerSaveMode: true },
      },
    ] satisfies Partial<CaptureLifeOpsActivitySignalRequest>[]) {
      await store.upsert(initialized);
      const before = Date.now();
      const first = post(owner, "active", positive);
      expect(await handleLifeOpsRoutes(first.ctx)).toBe(true);
      expect(first.res.statusCode).toBe(201);
      const after = Date.now();
      const response = JSON.parse(first.res.body ?? "{}") as {
        signal: { id: string; observedAt: string };
      };
      const admitted = readDossierActivityState(
        (await store.get(seed.taskId))?.metadata,
      )?.admitted;
      expect(admitted).toMatchObject({
        principalId: ownerId,
        signalId: response.signal.id,
      });
      if (!admitted) throw new Error("Expected persisted owner admission");
      expect(Date.parse(admitted.atIso)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(admitted.atIso)).toBeLessThanOrEqual(after);
      expect(response.signal.observedAt).toBe("2000-01-01T00:00:00.000Z");

      const repeated = post(owner, "active", positive);
      expect(await handleLifeOpsRoutes(repeated.ctx)).toBe(true);
      expect(repeated.res.statusCode).toBe(201);
      const persisted = await store.get(seed.taskId);
      expect(readDossierActivityState(persisted?.metadata)?.admitted).toEqual(
        admitted,
      );
      expect(
        readDossierActivityState(persisted?.metadata)?.consumedDay,
      ).toBeNull();
      expect(persisted?.state.status).toBe("scheduled");
    }
  });

  it("persists a native mobile activity event end-to-end and lists it back", async () => {
    const observedAt = "2026-07-23T06:15:00.000Z";
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "mobile_device",
        platform: "ios",
        state: "active",
        observedAt,
        idleState: "active",
        idleTimeSeconds: 4,
        onBattery: true,
        metadata: { reason: "resume", app: "com.eliza.app" },
      },
    });

    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(201);
    const created = JSON.parse(post.res.body ?? "{}") as {
      signal: {
        id: string;
        agentId: string;
        source: string;
        platform: string;
        state: string;
        observedAt: string;
        idleTimeSeconds: number | null;
        metadata: Record<string, unknown>;
      };
    };
    expect(created.signal.source).toBe("mobile_device");
    expect(created.signal.platform).toBe("ios");
    expect(created.signal.state).toBe("active");
    expect(created.signal.agentId).toBe(agentId);
    expect(created.signal.observedAt).toBe(observedAt);
    expect(created.signal.idleTimeSeconds).toBe(4);
    expect(created.signal.metadata).toMatchObject({ reason: "resume" });

    // Domain artifact: the primary row is really in the database.
    const rows = await adapter
      .getDatabase()
      .execute(
        sql.raw(
          "SELECT id, source, platform, state FROM app_lifeops.life_activity_signals",
        ),
      );
    expect(rows.rows).toEqual([
      expect.objectContaining({
        id: created.signal.id,
        source: "mobile_device",
        platform: "ios",
        state: "active",
      }),
    ]);

    // The canonical telemetry mirror received the same event (no silent
    // mirror failure — the runtime reported no errors).
    const mirrored = await adapter
      .getDatabase()
      .execute(sql.raw("SELECT family FROM app_lifeops.life_telemetry_events"));
    expect(mirrored.rows.length).toBe(1);
    expect(runtime.getRecentReportedErrors()).toEqual([]);

    // The LifeOps consumer surface reads it back through the GET route.
    const get = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/activity-signals",
      runtime,
    });
    expect(await handleLifeOpsRoutes(get.ctx)).toBe(true);
    expect(get.res.statusCode).toBe(200);
    const listed = JSON.parse(get.res.body ?? "{}") as {
      signals: Array<{ id: string; source: string }>;
    };
    expect(listed.signals).toEqual([
      expect.objectContaining({
        id: created.signal.id,
        source: "mobile_device",
      }),
    ]);
  });

  it("persists a page-visibility presence signal with the client-default platform", async () => {
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "page_visibility",
        platform: "web_app",
        state: "background",
        metadata: { reason: "blur", visibilityState: "hidden" },
      },
    });
    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(201);
    const created = JSON.parse(post.res.body ?? "{}") as {
      signal: { state: string; platform: string; observedAt: string };
    };
    expect(created.signal.state).toBe("background");
    expect(created.signal.platform).toBe("web_app");
    // observedAt defaults server-side when the client omits it.
    expect(Number.isFinite(Date.parse(created.signal.observedAt))).toBe(true);
  });

  it("disables routes on unload and restores them with a fresh registry on reload", async () => {
    await LifeOpsRepository.bootstrapSchema(runtime);
    deactivateLifeOpsActivitySignals(runtime);
    const reportError = vi.spyOn(runtime, "reportError");
    const lifecyclePlugin: Plugin = {
      name: "lifeops-activity-signal-lifecycle-regression",
      description: "Exercises the production activity-signal lifecycle hooks",
      init: async (_config, pluginRuntime) => {
        activateLifeOpsActivitySignals(pluginRuntime);
      },
      dispose: async (pluginRuntime) => {
        deactivateLifeOpsActivitySignals(pluginRuntime);
      },
    };

    await runtime.registerPlugin(lifecyclePlugin);
    const registryBeforeUnload = getSignalSourceRegistry(runtime);
    expect(registryBeforeUnload).not.toBeNull();
    const activePost = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "page_visibility",
        platform: "web_app",
        state: "active",
        metadata: { phase: "before-unload" },
      },
    });
    expect(await handleLifeOpsRoutes(activePost.ctx)).toBe(true);
    expect(activePost.res.statusCode).toBe(201);

    await runtime.unloadPlugin(lifecyclePlugin.name);
    expect(getSignalSourceRegistry(runtime)).toBeNull();
    const inactivePost = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "page_visibility",
        platform: "web_app",
        state: "background",
        metadata: { phase: "after-unload" },
      },
    });
    const readInactiveBody = vi.spyOn(inactivePost.ctx, "readJsonBody");
    expect(await handleLifeOpsRoutes(inactivePost.ctx)).toBe(true);
    expect(inactivePost.res.statusCode).toBe(503);
    expect(JSON.parse(inactivePost.res.body ?? "{}")).toEqual({
      error:
        "LifeOps activity signals are unavailable because the personal-assistant runtime is not active",
    });
    expect(readInactiveBody).not.toHaveBeenCalled();
    const inactiveGet = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/activity-signals",
      runtime,
    });
    expect(await handleLifeOpsRoutes(inactiveGet.ctx)).toBe(true);
    expect(inactiveGet.res.statusCode).toBe(503);

    await runtime.reloadPlugin(lifecyclePlugin);
    const registryAfterReload = getSignalSourceRegistry(runtime);
    expect(registryAfterReload).not.toBeNull();
    expect(registryAfterReload).not.toBe(registryBeforeUnload);
    const reloadedPost = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "app_lifecycle",
        platform: "desktop_app",
        state: "active",
        metadata: { phase: "after-reload" },
      },
    });
    expect(await handleLifeOpsRoutes(reloadedPost.ctx)).toBe(true);
    expect(reloadedPost.res.statusCode).toBe(201);

    const primaryRows = await adapter
      .getDatabase()
      .execute(
        sql.raw(
          "SELECT source FROM app_lifeops.life_activity_signals ORDER BY created_at",
        ),
      );
    expect(primaryRows.rows).toEqual([
      { source: "page_visibility" },
      { source: "app_lifecycle" },
    ]);
    expect(reportError).not.toHaveBeenCalled();
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  });

  it("rejects an unknown source with 400 and persists nothing", async () => {
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "keyboard_telepathy",
        state: "active",
      },
    });
    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(400);
    expect(JSON.parse(post.res.body ?? "{}")).toMatchObject({
      error: expect.stringContaining("source"),
    });

    const rows = await adapter
      .getDatabase()
      .execute(sql.raw("SELECT id FROM app_lifeops.life_activity_signals"));
    expect(rows.rows).toEqual([]);
  });

  it("rejects client-authored dossier admission before storing telemetry", async () => {
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "app_lifecycle",
        state: "active",
        metadata: { dossierActivity: { principalId: "owner", admitted: true } },
      },
    });
    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(400);
    const get = buildCtx({
      method: "GET",
      pathname: "/api/lifeops/activity-signals",
      runtime,
    });
    expect(await handleLifeOpsRoutes(get.ctx)).toBe(true);
    expect(get.res.statusCode).toBe(200);
    expect(JSON.parse(get.res.body ?? "{}").signals).toEqual([]);
  });

  it("rejects an invalid state with 400", async () => {
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: {
        source: "app_lifecycle",
        state: "levitating",
      },
    });
    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(400);
  });

  it("returns 503 when the agent runtime is unavailable", async () => {
    const post = buildCtx({
      method: "POST",
      pathname: "/api/lifeops/activity-signals",
      runtime,
      body: { source: "app_lifecycle", state: "active" },
    });
    post.ctx.state.runtime = null;
    expect(await handleLifeOpsRoutes(post.ctx)).toBe(true);
    expect(post.res.statusCode).toBe(503);
  });
});
