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
  // The replayed migrations enforce the real tenant foreign keys, so the
  // referenced organization and users must exist before an agent can.
  await dbWrite.execute(sql`
    INSERT INTO organizations (id) VALUES (${organizationId}) ON CONFLICT DO NOTHING
  `);
  for (const id of [ownerId, otherUserId]) {
    await dbWrite.execute(sql`
      INSERT INTO users (id) VALUES (${id}) ON CONFLICT DO NOTHING
    `);
  }
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

  // The remote_sessions table is built by replaying the real migrations rather
  // than hand-rolled here: 0068 carries the status CHECK and 0275 widens it, so
  // a lifecycle write that production would reject fails this suite too. The
  // sandbox table is created under its pre-rename name and renamed exactly as
  // production did, because that rename is what preserves the CHECK.
  await pglite.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE users (id uuid PRIMARY KEY);
    CREATE TABLE eliza_sandboxes (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL,
      user_id uuid NOT NULL,
      deleted_at timestamp with time zone
    );
  `);
  for (const migration of [
    "0068_add_remote_sessions",
    "0275_remote_sessions_first_class_expiry",
  ]) {
    const source = await Bun.file(
      new URL(
        `../../../../shared/src/db/migrations/${migration}.sql`,
        import.meta.url,
      ),
    ).text();
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) await pglite.exec(statement);
    }
  }
  await dbWrite.execute(
    sql`ALTER TABLE eliza_sandboxes RENAME TO agent_sandboxes`,
  );

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
    expect(row?.expires_at?.getTime()).toBe(Date.parse(body.data.expiresAt));
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

  test("rejects JSON null and non-object bodies as strict client errors", async () => {
    await seedAgent();
    for (const payload of ["null", "[]", '"agent"', "42"]) {
      const response = await app.fetch(
        new Request("https://api.example.test/api/v1/remote/pair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload,
        }),
        { REMOTE_PAIRING_HMAC_SECRET: secret } as AppEnv["Bindings"],
      );
      expect(response.status).toBe(400);
    }
    expect(await dbWrite.select().from(remoteSessions)).toHaveLength(0);
  });

  test("rejects malformed UUID input on list and revoke before touching the database", async () => {
    const listResponse = await app.request(
      "https://api.example.test/api/v1/remote/sessions?agentId=not-a-uuid",
    );
    expect(listResponse.status).toBe(400);
    const revokeResponse = await app.request(
      "https://api.example.test/api/v1/remote/sessions/not-a-uuid/revoke",
      { method: "POST" },
    );
    expect(revokeResponse.status).toBe(400);
  });

  test("expired pending grants transition to a terminal state and leave active listings", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };

    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET expires_at = now() - interval '1 minute'
      WHERE id = ${pairBody.data.sessionId}
    `);

    const listResponse = await app.request(
      `https://api.example.test/api/v1/remote/sessions?agentId=${agentId}`,
    );
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: { sessions: unknown[] };
    };
    expect(listBody.data.sessions).toHaveLength(0);

    const [stored] = await dbWrite.select().from(remoteSessions);
    expect(stored?.status).toBe("expired");
    expect(stored?.ended_at).not.toBeNull();

    const revokeResponse = await app.request(
      `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
      { method: "POST" },
    );
    expect(revokeResponse.status).toBe(200);
    const revokeBody = (await revokeResponse.json()) as {
      data: { alreadyEnded: boolean; status: string };
    };
    expect(revokeBody.data.alreadyEnded).toBe(true);
    expect(revokeBody.data.status).toBe("expired");
  });

  test("revoking a run-out pending grant directly reports expired, with no prior list", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET expires_at = now() - interval '1 minute'
      WHERE id = ${pairBody.data.sessionId}
    `);

    // Deliberately no list and no reissuance in between: revoke itself has to
    // reconcile the run-out grant, or it reports a fresh revocation of a row
    // whose authority already lapsed.
    const revokeResponse = await app.request(
      `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
      { method: "POST" },
    );
    expect(revokeResponse.status).toBe(200);
    const revokeBody = (await revokeResponse.json()) as {
      data: { alreadyEnded: boolean; status: string };
    };
    expect(revokeBody.data.status).toBe("expired");
    expect(revokeBody.data.alreadyEnded).toBe(true);

    const [stored] = await dbWrite.select().from(remoteSessions);
    expect(stored?.status).toBe("expired");
    expect(stored?.ended_at).not.toBeNull();
  });

  test("direct revocation of a run-out legacy grant terminalizes it as expired", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };
    // A row predating the first-class column whose signed verifier has lapsed:
    // listing already hides it, so revoke must agree rather than revoke it.
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET expires_at = NULL,
          pairing_token_hash = ${`hmac-sha256-v2:1000000000000:${"a".repeat(64)}`}
      WHERE id = ${pairBody.data.sessionId}
    `);

    const revokeBody = (await (
      await app.request(
        `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
        { method: "POST" },
      )
    ).json()) as { data: { alreadyEnded: boolean; status: string } };
    expect(revokeBody.data.status).toBe("expired");
    expect(revokeBody.data.alreadyEnded).toBe(true);
  });

  test("an active session survives pairing-challenge expiry and stays revocable", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };
    // Consuming the code promotes the grant; the challenge deadline passing
    // must not terminate the session it already produced.
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET status = 'active', expires_at = now() - interval '1 minute'
      WHERE id = ${pairBody.data.sessionId}
    `);

    const revokeBody = (await (
      await app.request(
        `https://api.example.test/api/v1/remote/sessions/${pairBody.data.sessionId}/revoke`,
        { method: "POST" },
      )
    ).json()) as { data: { alreadyEnded: boolean; status: string } };
    expect(revokeBody.data.status).toBe("revoked");
    expect(revokeBody.data.alreadyEnded).toBe(false);
  });

  test("the sweep terminalizes a grant stranded by an ownership transfer", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET expires_at = now() - interval '1 minute'
      WHERE id = ${pairBody.data.sessionId}
    `);
    // Every request-path predicate requires current ownership, so after the
    // transfer no owner-scoped call can ever reach this row again.
    await dbWrite.execute(
      sql`UPDATE agent_sandboxes SET user_id = ${otherUserId} WHERE id = ${agentId}`,
    );

    expect(
      (
        await app.request(
          `https://api.example.test/api/v1/remote/sessions?agentId=${agentId}`,
        )
      ).status,
    ).toBe(404);
    const [beforeSweep] = await dbWrite.select().from(remoteSessions);
    expect(beforeSweep?.status).toBe("pending");

    expect(await repository.expireRunOutPendingSessions()).toBe(1);
    const [afterSweep] = await dbWrite.select().from(remoteSessions);
    expect(afterSweep?.status).toBe("expired");
    expect(afterSweep?.ended_at).not.toBeNull();
    // Draining is idempotent: a second pass finds nothing left to terminalize.
    expect(await repository.expireRunOutPendingSessions()).toBe(0);
  });

  test("a legacy pending row without first-class expiry falls back to the verifier's signed expiry", async () => {
    await seedAgent();
    const pairBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };

    await dbWrite.execute(sql`
      UPDATE remote_sessions SET expires_at = NULL
      WHERE id = ${pairBody.data.sessionId}
    `);
    const currentList = (await (
      await app.request(
        `https://api.example.test/api/v1/remote/sessions?agentId=${agentId}`,
      )
    ).json()) as { data: { sessions: { id: string }[] } };
    expect(currentList.data.sessions.map((s) => s.id)).toEqual([
      pairBody.data.sessionId,
    ]);

    // A legacy row whose signed verifier expiry is in the past stays hidden.
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET pairing_token_hash = ${`hmac-sha256-v2:1000000000000:${"a".repeat(64)}`}
      WHERE id = ${pairBody.data.sessionId}
    `);
    const staleList = (await (
      await app.request(
        `https://api.example.test/api/v1/remote/sessions?agentId=${agentId}`,
      )
    ).json()) as { data: { sessions: unknown[] } };
    expect(staleList.data.sessions).toHaveLength(0);
  });

  test("issuance replaces run-out grants terminally instead of denying them", async () => {
    await seedAgent();
    const firstBody = (await (await pair()).json()) as {
      data: { sessionId: string };
    };
    await dbWrite.execute(sql`
      UPDATE remote_sessions
      SET expires_at = now() - interval '1 minute'
      WHERE id = ${firstBody.data.sessionId}
    `);

    const secondResponse = await pair();
    expect(secondResponse.status).toBe(200);
    const rows = await dbWrite.select().from(remoteSessions);
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.id === firstBody.data.sessionId);
    expect(first?.status).toBe("expired");
    expect(rows.filter((row) => row.status === "pending")).toHaveLength(1);
  });
});
