/** Real polling route/service/repository against independently lagging SQL stores. */
import { afterAll, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { Hono } from "hono";
import { apiKeys } from "../../db/schemas/api-keys";
import { cliAuthSessions } from "../../db/schemas/cli-auth-sessions";
import { organizations } from "../../db/schemas/organizations";

// Neither connection uses environment configuration or an external database.
const primary = new PGlite();
const replica = new PGlite();
const dbWrite = drizzle(primary);
const dbRead = drizzle(replica);
for (const db of [primary, replica]) {
  // This fixture tests read consistency, not FK/migration correctness. Derive
  // every selected column/type from the real schema; no repository is mocked.
  for (const table of [cliAuthSessions, apiKeys, organizations]) {
    const config = getTableConfig(table);
    await db.exec(
      `CREATE TABLE "${config.name}" (${config.columns
        .map((column) => `"${column.name}" ${column.getSQLType()}`)
        .join(", ")})`,
    );
  }
}
mock.module("../../db/helpers", () => ({ dbWrite, dbRead }));
const { cliAuthSessionsRepository } = await import("../../db/repositories/cli-auth-sessions");
mock.module("../../db/repositories", () => ({ cliAuthSessionsRepository }));
// These external effect paths must not be involved in a status-only poll. Only
// the keys of the reveal test below are ever decrypted.
const revealable = new Set<string>();
mock.module("../../db/crypto/api-keys", () => ({
  decryptApiKey: (keyId: string) => {
    if (!revealable.has(keyId)) throw new Error("Unexpected key decryption");
    return `synthetic-key-${keyId}`;
  },
}));
mock.module("./api-keys", () => ({ apiKeysService: {} }));
mock.module("./cli-auth-session-completion", () => ({ cliAuthSessionCompletionService: {} }));
const { default: poll } = await import("../../../../api/auth/cli-session/[sessionId]/route");
const app = new Hono().route("/api/auth/cli-session/:sessionId", poll);
const id = "00000000-0000-4000-8000-000000000123";
const request = (sessionId = id) =>
  app.request(`http://localhost/api/auth/cli-session/${sessionId}`);
afterAll(async () => {
  await primary.close();
  await replica.close();
  mock.restore();
});

test("new sessions remain pollable before replica arrival; completion and expiry use current primary state", async () => {
  const row = {
    id,
    session_id: id,
    status: "pending" as const,
    expires_at: new Date(Date.now() + 600_000),
    created_at: new Date(),
    updated_at: new Date(),
  };
  await dbWrite.insert(cliAuthSessions).values(row);
  expect(await dbRead.select().from(cliAuthSessions)).toHaveLength(0);
  for (const response of await Promise.all(Array.from({ length: 4 }, () => request()))) {
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "pending" });
  }
  // Replica catches up once, then lags the completed/consumed primary session.
  await dbRead.insert(cliAuthSessions).values(row);
  await dbWrite
    .update(cliAuthSessions)
    .set({ status: "authenticated", consumed_at: new Date() })
    .where(eq(cliAuthSessions.session_id, id));
  const completed = await request();
  expect(completed.status).toBe(200);
  expect(await completed.json()).toEqual({
    status: "authenticated",
    message: "API key already retrieved",
  });
  expect((await dbRead.select().from(cliAuthSessions))[0]?.status).toBe("pending");
  await dbWrite
    .update(cliAuthSessions)
    .set({ expires_at: new Date(Date.now() - 60_000) })
    .where(eq(cliAuthSessions.session_id, id));
  const expired = await request();
  expect(expired.status).toBe(404);
  expect(await expired.json()).toEqual({ error: "Session not found or expired" });
  expect((await request("00000000-0000-4000-8000-000000000124")).status).toBe(404);
  expect((await request("not-a-session")).status).toBe(400);
}, 30_000);

test("the reply that reveals the key says whether this sign-in made the account", async () => {
  const userId = "00000000-0000-4000-8000-0000000000a1";
  const started = new Date(Date.now() - 60_000);
  const reveal = async (n: number, organizationCreatedAt: Date) => {
    const sessionId = `00000000-0000-4000-8000-00000000020${n}`;
    const keyId = `00000000-0000-4000-8000-00000000030${n}`;
    const organizationId = `00000000-0000-4000-8000-00000000040${n}`;
    await dbWrite.insert(organizations).values({
      id: organizationId,
      name: `Organization ${n}`,
      slug: `organization-${n}`,
      created_at: organizationCreatedAt,
    });
    await dbWrite.insert(apiKeys).values({
      id: keyId,
      name: "CLI login",
      key_hash: `hash-${n}`,
      key_prefix: "eliza_",
      organization_id: organizationId,
      user_id: userId,
      is_active: true,
      key_ciphertext: "ciphertext",
      key_nonce: "nonce",
      key_auth_tag: "tag",
      key_kms_key_id: "kms",
      key_kms_key_version: 1,
    });
    await dbWrite.insert(cliAuthSessions).values({
      id: sessionId,
      session_id: sessionId,
      user_id: userId,
      api_key_id: keyId,
      status: "authenticated",
      expires_at: new Date(Date.now() + 600_000),
      created_at: started,
      updated_at: started,
    });
    revealable.add(keyId);
    const first = await request(sessionId);
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.apiKey).toBe(`synthetic-key-${keyId}`);
    // The key is single-use: a second poll neither reveals it nor repeats the fact.
    expect(await (await request(sessionId)).json()).toEqual({
      status: "authenticated",
      message: "API key already retrieved",
    });
    return body.accountCreated;
  };
  // Made during this sign-in (after the session started) or long before it.
  expect(await reveal(1, new Date(started.getTime() + 5_000))).toBe(true);
  expect(await reveal(2, new Date(started.getTime() - 86_400_000))).toBe(false);
}, 30_000);
