/**
 * Real TCP and PGlite coverage for database authorization, cookie-CSRF, and
 * raw-SQL denial. Requests traverse the production server and dispatcher; only
 * the embedding host's deterministic session resolver is injected.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { AgentRuntime } from "@elizaos/core";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _resetAgentHostBridge,
  defaultAgentHostBridge,
  setAgentHostBridge,
} from "../runtime/host-bridge.ts";
import { startApiServer } from "./server.ts";

type ApiServer = Awaited<ReturnType<typeof startApiServer>>;

const REMOTE_HEADERS = {
  Origin: "https://trusted.example",
  "x-forwarded-for": "203.0.113.10",
} as const;
const touchedEnv = [
  "ELIZA_ALLOWED_ORIGINS",
  "ELIZA_API_BIND_HOST",
  "ELIZA_API_PORT",
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_PORT",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
  "STEWARD_AGENT_TOKEN",
] as const;

let api: ApiServer | null = null;
let pglite: PGlite | null = null;
let stateDir: string | null = null;
const originalEnv = new Map<string, string | undefined>();

function endpoint(pathname: string): string {
  if (!api) throw new Error("test server is not running");
  return `http://127.0.0.1:${api.port}${pathname}`;
}

function sessionHeaders(
  session: "owner" | "user" | "guest",
  csrf?: string,
): Record<string, string> {
  return {
    ...REMOTE_HEADERS,
    Cookie: `eliza_session=${session}`,
    ...(csrf ? { "X-Eliza-CSRF": csrf } : {}),
  };
}

async function widgetRows(): Promise<Array<Record<string, unknown>>> {
  if (!pglite) throw new Error("test database is not running");
  const result = await pglite.query(
    "SELECT id, label FROM guarded_widgets ORDER BY id",
  );
  return result.rows as Array<Record<string, unknown>>;
}

beforeAll(async () => {
  for (const key of touchedEnv) originalEnv.set(key, process.env[key]);
  stateDir = await mkdtemp(path.join(tmpdir(), "eliza-database-auth-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  process.env.ELIZA_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(stateDir, "eliza.json");
  process.env.ELIZA_API_BIND_HOST = "127.0.0.1";
  process.env.ELIZA_CLOUD_PROVISIONED = "1";
  process.env.STEWARD_AGENT_TOKEN = "test-cloud-container";
  process.env.ELIZA_ALLOWED_ORIGINS = REMOTE_HEADERS.Origin;
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;

  pglite = new PGlite();
  await pglite.waitReady;
  await pglite.exec(`
    CREATE TABLE guarded_widgets (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL
    );
    INSERT INTO guarded_widgets (label) VALUES ('original');
  `);
  const runtime = {
    agentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    character: { name: "DatabaseAuthTest" },
    adapter: { db: drizzle(pglite) },
    plugins: [],
    routes: [],
    getLastResolvedModelProvider: () => undefined,
    getModelRegistrations: () => [],
    getService: () => null,
    hasService: () => false,
    getRoomsByWorld: async () => [],
    getAgent: async () => null,
    getSetting: () => undefined,
    registerEvent: () => undefined,
  } as unknown as AgentRuntime;

  setAgentHostBridge({
    ...defaultAgentHostBridge,
    resolveHttpRequestAuthorization: async (req, _runtime, options) => {
      if (!options.allowCookieAuth) return { ok: false, role: "NONE" };
      const cookie =
        typeof req.headers.cookie === "string" ? req.headers.cookie : "";
      const session = /eliza_session=(owner|user|guest)/.exec(cookie)?.[1];
      if (!session) return { ok: false, role: "NONE" };
      const method = (req.method ?? "GET").toUpperCase();
      if (
        ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
        req.headers["x-eliza-csrf"] !== "valid-csrf"
      ) {
        return { ok: false, role: "NONE" };
      }
      const role =
        session === "owner" ? "OWNER" : session === "user" ? "USER" : "GUEST";
      return { ok: true, role, identityId: session };
    },
  });

  api = await startApiServer({
    port: 0,
    runtime,
    skipDeferredStartupWork: true,
  });
}, 30_000);

afterAll(async () => {
  await api?.close();
  await pglite?.close();
  api = null;
  pglite = null;
  _resetAgentHostBridge();
  if (stateDir) {
    await rm(stateDir, { recursive: true, force: true });
  }
  stateDir = null;
  for (const key of touchedEnv) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
}, 30_000);

describe("database authorization over the real server", () => {
  beforeEach(async () => {
    await pglite?.exec(`
      TRUNCATE TABLE guarded_widgets RESTART IDENTITY;
      INSERT INTO guarded_widgets (label) VALUES ('original');
    `);
  });

  it("denies anonymous, missing-CSRF, USER, and GUEST mutations without changing rows", async () => {
    const target = endpoint("/api/database/tables/guarded_widgets/rows");
    const attempts = [
      { headers: REMOTE_HEADERS, expected: 401 },
      { headers: sessionHeaders("owner"), expected: 401 },
      { headers: sessionHeaders("owner", "wrong-csrf"), expected: 401 },
      { headers: sessionHeaders("user", "valid-csrf"), expected: 403 },
      { headers: sessionHeaders("guest", "valid-csrf"), expected: 403 },
    ];
    const mutations = [
      { method: "POST", body: { data: { label: "unauthorized" } } },
      {
        method: "PUT",
        body: { where: { id: 1 }, data: { label: "unauthorized" } },
      },
      { method: "DELETE", body: { where: { id: 1 } } },
    ];

    for (const attempt of attempts) {
      for (const mutation of mutations) {
        const response = await fetch(target, {
          method: mutation.method,
          headers: {
            ...attempt.headers,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(mutation.body),
        });
        expect(response.status, await response.text()).toBe(attempt.expected);
        expect(await widgetRows()).toEqual([{ id: 1, label: "original" }]);
      }
    }
  });

  it("allows an OWNER mutation only with the host-validated CSRF token", async () => {
    const response = await fetch(
      endpoint("/api/database/tables/guarded_widgets/rows"),
      {
        method: "POST",
        headers: {
          ...sessionHeaders("owner", "valid-csrf"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ data: { label: "authorized" } }),
      },
    );

    expect(response.status, await response.text()).toBe(201);
    expect(await widgetRows()).toEqual([
      { id: 1, label: "original" },
      { id: 2, label: "authorized" },
    ]);
  });

  it("rejects raw UPDATE, DELETE, and DDL even for OWNER with readOnly:false", async () => {
    for (const sql of [
      "UPDATE guarded_widgets SET label = 'raw-update' WHERE id = 1",
      "DELETE FROM guarded_widgets WHERE id = 1",
      "DROP TABLE guarded_widgets",
    ]) {
      const response = await fetch(endpoint("/api/database/query"), {
        method: "POST",
        headers: {
          ...sessionHeaders("owner", "valid-csrf"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ sql, readOnly: false }),
      });
      expect(response.status, await response.text()).toBe(400);
    }

    expect(await widgetRows()).toEqual([{ id: 1, label: "original" }]);
  });
});
