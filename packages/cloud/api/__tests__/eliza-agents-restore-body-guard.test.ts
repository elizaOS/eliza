/**
 * Agent-management POST routes must not 500 on caller-shaped input (#13406).
 *
 * /restore ran an unguarded `await request.json()`, so the canonical
 * bodyless "restore the latest backup" call (every field is optional) threw a
 * SyntaxError that errorToResponse maps to 500 — same for /bridge and
 * /stream on an empty or malformed body. /restore also surfaced the
 * service's "Backup does not belong to this agent" ownership check as a 500
 * with a distinct message, making backup ids a cross-agent/cross-org
 * existence oracle. Real route modules + real repositories against
 * in-process PGlite; the only mocked seam is `requireAuthOrApiKeyWithOrg`
 * (same pattern as org-credentials-routes / my-agents-characters-search).
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { Hono } from "hono";
import * as realAuth from "@/lib/auth";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
const USER_B = "bbbbbbbb-1111-4111-8111-111111111111";
const AGENT_A = "cccccccc-1111-4111-8111-111111111111";
const AGENT_B = "cccccccc-2222-4222-8222-222222222222";
const BACKUP_B = "dddddddd-1111-4111-8111-111111111111";
const BACKUP_A_OLD = "dddddddd-2222-4222-8222-222222222222";
const BACKUP_A_NEW = "dddddddd-3333-4333-8333-333333333333";

// Caller is always org A's user; agent B + backup B live in org B so the
// cross-org backupId probe exercises the ownership check for real.
mock.module("@/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg: mock(async () => ({
    user: {
      id: USER_A,
      email: "owner@test.test",
      organization_id: ORG_A,
      organization: { id: ORG_A, name: "Org A", is_active: true },
      is_active: true,
      role: "owner",
    },
  })),
}));

const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

let pgliteReady = true;
let closeDb: (() => Promise<void>) | undefined;
let app: Hono<AppEnv>;

beforeAll(async () => {
  try {
    const { closeDatabaseConnectionsForTests, dbWrite } = await import(
      "@/db/client"
    );
    closeDb = closeDatabaseConnectionsForTests;

    const { organizations } = await import("@/db/schemas/organizations");
    const { users } = await import("@/db/schemas/users");
    const { userCharacters } = await import("@/db/schemas/user-characters");
    const { agentSandboxes, agentSandboxBackups } = await import(
      "@/db/schemas/agent-sandboxes"
    );
    const { pushSchema } = await import("@/db/push-schema-for-tests");
    const { apply } = await pushSchema(
      {
        organizations,
        users,
        userCharacters,
        agentSandboxes,
        agentSandboxBackups,
      } as never,
      dbWrite as never,
    );
    await apply();

    await dbWrite.insert(organizations).values([
      { id: ORG_A, name: "Org A", slug: "org-a" },
      { id: ORG_B, name: "Org B", slug: "org-b" },
    ]);
    await dbWrite.insert(users).values([
      {
        id: USER_A,
        email: "owner@test.test",
        organization_id: ORG_A,
        role: "owner",
        steward_user_id: `steward-${USER_A}`,
      },
      {
        id: USER_B,
        email: "other@test.test",
        organization_id: ORG_B,
        role: "owner",
        steward_user_id: `steward-${USER_B}`,
      },
    ]);

    // Agent A: dedicated, never provisioned (status "stopped", no bridge) —
    // the fresh/suspended console state the restore panel acts on.
    await dbWrite.insert(agentSandboxes).values([
      {
        id: AGENT_A,
        organization_id: ORG_A,
        user_id: USER_A,
        agent_name: "Agent A",
        execution_tier: "dedicated-lazy",
        status: "stopped",
      },
      {
        id: AGENT_B,
        organization_id: ORG_B,
        user_id: USER_B,
        agent_name: "Agent B",
        execution_tier: "dedicated-lazy",
        status: "stopped",
      },
    ]);

    // Backups: one for org B's agent (the foreign backupId probe target) —
    // agent A starts with NONE (the empty first-time state).
    await dbWrite.insert(agentSandboxBackups).values([
      {
        id: BACKUP_B,
        sandbox_record_id: AGENT_B,
        snapshot_type: "manual",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
      },
    ]);

    const restoreRoute = (
      await import("../v1/eliza/agents/[agentId]/restore/route")
    ).default;
    const bridgeRoute = (
      await import("../v1/eliza/agents/[agentId]/bridge/route")
    ).default;
    const streamRoute = (
      await import("../v1/eliza/agents/[agentId]/stream/route")
    ).default;
    app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId/restore", restoreRoute);
    app.route("/api/v1/eliza/agents/:agentId/bridge", bridgeRoute);
    app.route("/api/v1/eliza/agents/:agentId/stream", streamRoute);
  } catch (error) {
    pgliteReady = false;
    console.error(
      "[eliza-agents-restore-body-guard.test] setup failed — failing.",
      error,
    );
  }
}, 120_000);

afterAll(async () => {
  if (closeDb) await closeDb();
  mock.restore();
});

function post(path: string, body?: BodyInit, contentType = "application/json") {
  return app.request(
    path,
    {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": contentType },
      ...(body === undefined ? {} : { body }),
    },
    ENV,
  );
}

describe("POST /api/v1/eliza/agents/:agentId/restore — body + ownership guards", () => {
  test("bodyless restore-latest with no backups is a typed 404, not a 500", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(`/api/v1/eliza/agents/${AGENT_A}/restore`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("No backup found");
  });

  test("console `{}` body behaves identically to no body", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(
      `/api/v1/eliza/agents/${AGENT_A}/restore`,
      JSON.stringify({}),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("No backup found");
  });

  test("malformed JSON body is a typed 400, not a 500", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(`/api/v1/eliza/agents/${AGENT_A}/restore`, "{nope");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid JSON body");
  });

  test("another org's backupId is indistinguishable from a nonexistent one (404, no oracle)", async () => {
    expect(pgliteReady).toBe(true);

    const foreign = await post(
      `/api/v1/eliza/agents/${AGENT_A}/restore`,
      JSON.stringify({ backupId: BACKUP_B }),
    );
    expect(foreign.status).toBe(404);
    const foreignBody = (await foreign.json()) as { error: string };
    expect(foreignBody.error).toBe("No backup found");

    const missing = await post(
      `/api/v1/eliza/agents/${AGENT_A}/restore`,
      JSON.stringify({ backupId: "eeeeeeee-1111-4111-8111-111111111111" }),
    );
    expect(missing.status).toBe(404);
    const missingBody = (await missing.json()) as { error: string };
    expect(missingBody.error).toBe("No backup found");
  });

  test("parsed backupId still drives the real service path (409 on non-latest for a stopped agent)", async () => {
    expect(pgliteReady).toBe(true);

    const { dbWrite } = await import("@/db/client");
    const { agentSandboxBackups } = await import(
      "@/db/schemas/agent-sandboxes"
    );
    await dbWrite.insert(agentSandboxBackups).values([
      {
        id: BACKUP_A_OLD,
        sandbox_record_id: AGENT_A,
        snapshot_type: "manual",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
        created_at: new Date("2026-07-01T00:00:00.000Z"),
      },
      {
        id: BACKUP_A_NEW,
        sandbox_record_id: AGENT_A,
        snapshot_type: "manual",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        size_bytes: 16,
        created_at: new Date("2026-07-02T00:00:00.000Z"),
      },
    ]);

    const res = await post(
      `/api/v1/eliza/agents/${AGENT_A}/restore`,
      JSON.stringify({ backupId: BACKUP_A_OLD }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      "Stopped agents can only restore the latest backup",
    );
  });
});

describe("POST /bridge and /stream — malformed body guards", () => {
  test("bodyless bridge call is a typed 400, not a 500", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(`/api/v1/eliza/agents/${AGENT_A}/bridge`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(body.error).toBe("Invalid JSON body");
  });

  test("malformed bridge body is a typed 400", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(`/api/v1/eliza/agents/${AGENT_A}/bridge`, "{nope");
    expect(res.status).toBe(400);
  });

  test("bodyless stream call is a typed 400, not a 500", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(`/api/v1/eliza/agents/${AGENT_A}/stream`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("valid-JSON invalid-schema bridge body still returns the zod 400 (guard is parse-only)", async () => {
    expect(pgliteReady).toBe(true);

    const res = await post(
      `/api/v1/eliza/agents/${AGENT_A}/bridge`,
      JSON.stringify({ method: "message.send" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Invalid JSON-RPC request");
  });
});
