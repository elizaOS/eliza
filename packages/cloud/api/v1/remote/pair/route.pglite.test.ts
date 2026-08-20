/**
 * Exercises remote pairing through real Hono routes and the PGlite-backed
 * repository. Authentication is deterministic, while ownership locking,
 * verifier persistence, supersession, and revocation use production queries.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  setDefaultTimeout,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import type { Database } from "@/db/client";
import { RemoteSessionsRepository } from "@/db/repositories/remote-sessions-store";
import { agentSandboxes } from "@/db/schemas/agent-sandboxes";
import { remoteSessions } from "@/db/schemas/remote-sessions";
import type { AppEnv } from "@/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(300_000);

const organizationId = "10000000-0000-4000-8000-000000000001";
const ownerId = "20000000-0000-4000-8000-000000000001";
const otherUserId = "20000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000001";
const secret = "pglite-remote-pairing-secret-at-least-32-bytes";

let authenticatedUser = { id: ownerId, organization_id: organizationId };
const requireUserOrApiKeyWithOrg = mock(async () => authenticatedUser);
const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: authenticatedUser,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg }));

let repository: RemoteSessionsRepository;
const repositoryProxy = {
  createPendingForOwnedAgent: (
    ...args: Parameters<RemoteSessionsRepository["createPendingForOwnedAgent"]>
  ) => repository.createPendingForOwnedAgent(...args),
  listActiveByOwnedAgent: (
    ...args: Parameters<RemoteSessionsRepository["listActiveByOwnedAgent"]>
  ) => repository.listActiveByOwnedAgent(...args),
  revoke: (...args: Parameters<RemoteSessionsRepository["revoke"]>) =>
    repository.revoke(...args),
};
mock.module("@/db/repositories/remote-sessions", () => ({
  remoteSessionsRepository: repositoryProxy,
}));

let pglite: PGlite;
let dbWrite: Database;
let verifyRemotePairingCodeVerifier: typeof import("@/db/crypto/remote-pairing-code").verifyRemotePairingCodeVerifier;
let app: Hono<AppEnv>;

async function seedAgent(userId = ownerId, deleted = false): Promise<void> {
  await dbWrite.execute(sql`
    INSERT INTO agent_sandboxes (id, organization_id, user_id, deleted_at)
    VALUES (${agentId}, ${organizationId}, ${userId}, ${deleted ? new Date() : null})
  `);
}

async function pair(): Promise<Response> {
  return app.fetch(
    new Request("https://api.example.test/api/v1/remote/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        organizationId: "attacker-org",
        userId: otherUserId,
        redirectUri: "https://attacker.example/callback",
        purpose: "arbitrary-authority",
      }),
    }),
    { REMOTE_PAIRING_HMAC_SECRET: secret } as AppEnv["Bindings"],
  );
}

beforeAll(async () => {
  pglite = new PGlite();
  dbWrite = drizzle({
    client: pglite,
    schema: { agentSandboxes, remoteSessions },
  }) as unknown as Database;
  repository = new RemoteSessionsRepository(dbWrite);
  ({ verifyRemotePairingCodeVerifier } = await import(
    "@/db/crypto/remote-pairing-code"
  ));

  await dbWrite.execute(sql`
    CREATE TABLE agent_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      deleted_at timestamp with time zone
    )
  `);
  await dbWrite.execute(sql`
    CREATE TABLE remote_sessions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      agent_id uuid NOT NULL,
      status text NOT NULL,
      requester_identity text NOT NULL,
      pairing_token_hash text,
      ingress_url text,
      ingress_reason text,
      created_at timestamp with time zone NOT NULL DEFAULT now(),
      updated_at timestamp with time zone NOT NULL DEFAULT now(),
      ended_at timestamp with time zone
    )
  `);

  const { default: pairRoute } = await import("./route");
  const { default: sessionsRoute } = await import("../sessions/route");
  const { default: revokeRoute } = await import(
    "../sessions/[id]/revoke/route"
  );
  app = new Hono<AppEnv>();
  app.route("/api/v1/remote/pair", pairRoute);
  app.route("/api/v1/remote/sessions", sessionsRoute);
  app.route("/api/v1/remote/sessions/:id/revoke", revokeRoute);
}, 180_000);

beforeEach(async () => {
  authenticatedUser = { id: ownerId, organization_id: organizationId };
  await dbWrite.delete(remoteSessions);
  await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
}, 180_000);

afterAll(async () => {
  if (pglite) await pglite.close();
}, 180_000);

describe("remote pairing real persistence boundary", () => {
  test("persists a verifier bound to authoritative tenant, owner, agent, and session", async () => {
    await seedAgent();

    const response = await pair();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = (await response.json()) as {
      data: { sessionId: string; code: string; expiresAt: string };
    };
    const [row] = await dbWrite.select().from(remoteSessions);
    expect(row?.requester_identity).toBe(ownerId);
    expect(row?.pairing_token_hash).toMatch(
      /^hmac-sha256-v2:\d{13}:[0-9a-f]{64}$/,
    );
    expect(row?.pairing_token_hash).not.toContain(body.data.code);

    const context = {
      organizationId,
      userId: ownerId,
      agentId,
      sessionId: body.data.sessionId,
    };
    const verifier = row?.pairing_token_hash ?? "";
    const beforeExpiry = new Date(Date.parse(body.data.expiresAt) - 1);
    expect(
      await verifyRemotePairingCodeVerifier(
        secret,
        context,
        body.data.code,
        verifier,
        beforeExpiry,
      ),
    ).toBe(true);
    for (const foreignContext of [
      { ...context, organizationId: "10000000-0000-4000-8000-000000000002" },
      { ...context, userId: otherUserId },
      { ...context, agentId: "30000000-0000-4000-8000-000000000002" },
      { ...context, sessionId: "40000000-0000-4000-8000-000000000002" },
    ]) {
      expect(
        await verifyRemotePairingCodeVerifier(
          secret,
          foreignContext,
          body.data.code,
          verifier,
          beforeExpiry,
        ),
      ).toBe(false);
    }
  });

  test("rejects foreign and deleted agents without creating state", async () => {
    await seedAgent(otherUserId);
    expect((await pair()).status).toBe(404);
    expect(await dbWrite.select().from(remoteSessions)).toHaveLength(0);

    await dbWrite.execute(sql`DELETE FROM agent_sandboxes`);
    await seedAgent(ownerId, true);
    expect((await pair()).status).toBe(404);
    expect(await dbWrite.select().from(remoteSessions)).toHaveLength(0);
  });

  test("serializes concurrent issuers and leaves exactly one current challenge", async () => {
    await seedAgent();

    const responses = await Promise.all([pair(), pair(), pair(), pair()]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(
      responses.map(
        async (response) =>
          (await response.json()) as {
            data: { sessionId: string; code: string };
          },
      ),
    );
    const rows = await dbWrite.select().from(remoteSessions);
    expect(rows).toHaveLength(4);
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "denied")).toHaveLength(3);
    const pending = rows.find((row) => row.status === "pending");
    const pendingResponse = bodies.find(
      (body) => body.data.sessionId === pending?.id,
    );
    expect(pendingResponse).toBeDefined();
    expect(pending?.ended_at).toBeNull();
    expect(
      rows
        .filter((row) => row.status === "denied")
        .every((row) => row.ended_at),
    ).toBe(true);
  });

  test("an ownership transfer hides the old grant and prevents its revocation path", async () => {
    await seedAgent();
    const pairResponse = await pair();
    const pairBody = (await pairResponse.json()) as {
      data: { sessionId: string };
    };

    await dbWrite.execute(
      sql`UPDATE agent_sandboxes SET user_id = ${otherUserId} WHERE id = ${agentId}`,
    );

    const listResponse = await app.request(
      `https://api.example.test/api/v1/remote/sessions?agentId=${agentId}`,
    );
    expect(listResponse.status).toBe(404);
    const revokeResponse = await app.request(
      `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
      { method: "POST" },
    );
    expect(revokeResponse.status).toBe(404);
    const [stored] = await dbWrite.select().from(remoteSessions);
    expect(stored?.status).toBe("pending");
  });

  test("serializes concurrent revocations as one transition and idempotent replays", async () => {
    await seedAgent();
    const pairResponse = await pair();
    const pairBody = (await pairResponse.json()) as {
      data: { sessionId: string };
    };

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.request(
          `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
          { method: "POST" },
        ),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const bodies = await Promise.all(
      responses.map(
        async (response) =>
          (await response.json()) as { data: { alreadyEnded: boolean } },
      ),
    );
    expect(
      bodies.filter((body) => body.data.alreadyEnded === false),
    ).toHaveLength(1);
    expect(
      bodies.filter((body) => body.data.alreadyEnded === true),
    ).toHaveLength(3);
    const [stored] = await dbWrite.select().from(remoteSessions);
    expect(stored?.status).toBe("revoked");
    expect(stored?.ended_at).not.toBeNull();
  });
});
