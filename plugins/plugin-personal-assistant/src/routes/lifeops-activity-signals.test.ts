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
import { AgentRuntime, type Character, type UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PgliteDatabaseAdapter } from "../../../plugin-sql/src/pglite/adapter.js";
import { PGliteClientManager } from "../../../plugin-sql/src/pglite/manager.js";
import {
  createSignalSourceRegistry,
  registerSignalSourceRegistry,
} from "../lifeops/registries/signal-source-registry.js";
import { registerBuiltinSignalSources } from "../lifeops/telemetry-mapping.js";
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
    const registry = createSignalSourceRegistry();
    registerBuiltinSignalSources(registry);
    registerSignalSourceRegistry(runtime, registry);
  });

  afterEach(async () => {
    await adapter.close();
    await manager.close();
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
