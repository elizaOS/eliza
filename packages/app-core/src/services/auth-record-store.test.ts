/** Exercises real SQLite auth persistence, atomic claims and HTTP session authority. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  resolveAuthorizedRouteRole,
  resolveSessionTokenRole,
} from "../api/auth";
import {
  BROWSER_SESSION_TTL_MS,
  CSRF_HEADER_NAME,
  deriveCsrfToken,
  findActiveSession,
  readActiveSession,
  SESSION_COOKIE_NAME,
} from "../api/auth/sessions";
import {
  type AuthRepository,
  authStoreForRuntime,
  type CreateSessionInput,
} from "./auth-store";

let directory: string;
let adapter: SQLiteDatabaseAdapter;
let store: AuthRepository;
let server: Server | undefined;
const agentId = randomUUID() as UUID;
const now = 1_800_000_000_000;
async function open() {
  adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const selected = authStoreForRuntime({ agentId, adapter });
  if (!selected) throw new Error("SQLite auth store was not selected");
  store = selected;
}
async function identity(id = "owner", kind: "owner" | "machine" = "owner") {
  return store.createIdentity({
    id,
    kind,
    displayName: id,
    createdAt: now,
    passwordHash: null,
    cloudUserId: null,
  });
}
function session(id: string, identityId = "owner"): CreateSessionInput {
  return {
    id,
    identityId,
    kind: "browser",
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + 60_000,
    rememberDevice: false,
    csrfSecret: "test-csrf-secret",
    ip: null,
    userAgent: null,
    scopes: [],
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "auth-sqlite-"));
  await open();
});
afterEach(async () => {
  if (server) {
    const closing = server;
    await new Promise<void>((resolve, reject) =>
      closing.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
  }
  await adapter.close();
  await rm(directory, { recursive: true, force: true });
});
it("reopens existing identity, session, binding, token and audit records", async () => {
  await identity();
  await store.createSession(session("browser"));
  await store.createOwnerBinding({
    id: "binding",
    identityId: "owner",
    connector: "test",
    externalId: "external",
    instanceId: "instance",
    displayHandle: "test",
    verifiedAt: now,
  });
  await store.createOwnerLoginToken({
    tokenHash: "token-hash",
    identityId: "owner",
    bindingId: "binding",
    issuedAt: now,
    expiresAt: now + 1000,
  });
  const event = {
    id: "audit",
    ts: now,
    actorIdentityId: "owner",
    ip: null,
    userAgent: null,
    action: "test",
    outcome: "success" as const,
    metadata: { source: "test" },
  };
  await store.appendAuditEvent(event);
  await adapter.close();
  await open();
  expect(await store.findIdentity("owner")).toMatchObject({ kind: "owner" });
  expect(await store.findSession("browser", now)).toMatchObject({
    identityId: "owner",
  });
  expect(await store.findOwnerBinding("binding")).toMatchObject({
    connector: "test",
  });
  expect(await store.findOwnerLoginToken("token-hash")).toMatchObject({
    consumedAt: null,
  });
  expect(
    await adapter.recordStore.get("plugin_app_auth_audit_v1", "audit"),
  ).toEqual(event);
});
it("serializes competing one-use claims and preserves them across restart", async () => {
  await identity();
  await store.createOwnerBinding({
    id: "binding",
    identityId: "owner",
    connector: "test",
    externalId: "external",
    instanceId: "instance",
    displayHandle: "test",
    verifiedAt: now,
  });
  await store.createOwnerLoginToken({
    tokenHash: "token",
    identityId: "owner",
    bindingId: "binding",
    issuedAt: now,
    expiresAt: now + 1000,
  });
  const sibling = authStoreForRuntime({ agentId, adapter });
  if (!sibling) throw new Error("Second store was not selected");
  expect(
    await Promise.all([
      store.recordJtiSeen("jti", now),
      sibling.recordJtiSeen("jti", now),
    ]),
  ).toEqual([true, false]);
  expect(
    await Promise.all([
      store.consumeOwnerLoginToken("token", now),
      sibling.consumeOwnerLoginToken("token", now),
    ]),
  ).toEqual([true, false]);
  await adapter.close();
  await open();
  expect(await store.recordJtiSeen("jti", now)).toBe(false);
  expect(await store.consumeOwnerLoginToken("token", now)).toBe(false);
});
it("preserves references, unique bindings, expiry and binding-delete cascade", async () => {
  await expect(store.createSession(session("orphan"))).rejects.toMatchObject({
    code: "AUTH_RECORD_IDENTITY_MISSING",
  });
  await identity();
  const binding = {
    id: "binding",
    identityId: "owner",
    connector: "test",
    externalId: "external",
    instanceId: "instance",
    displayHandle: "test",
    verifiedAt: now,
  };
  const results = await Promise.allSettled([
    store.createOwnerBinding(binding),
    store.createOwnerBinding({ ...binding, id: "duplicate" }),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  await identity("another-owner");
  await expect(
    store.createOwnerLoginToken({
      tokenHash: "mismatched",
      identityId: "another-owner",
      bindingId: "binding",
      issuedAt: now,
      expiresAt: now + 1000,
    }),
  ).rejects.toMatchObject({ code: "AUTH_RECORD_BINDING_IDENTITY_MISMATCH" });
  expect(await store.findOwnerLoginToken("mismatched")).toBeNull();
  await store.createOwnerLoginToken({
    tokenHash: "expired",
    identityId: "owner",
    bindingId: "binding",
    issuedAt: now - 1000,
    expiresAt: now,
  });
  expect(await store.consumeOwnerLoginToken("expired", now)).toBe(false);
  expect(await store.deleteOwnerBinding("binding")).toBe(true);
  expect(await store.findOwnerLoginToken("expired")).toBeNull();
});
it("does not resurrect revoked sessions through concurrent touch or reopen", async () => {
  await identity();
  await store.createSession(session("revoked"));
  await store.createSession(session("retained"));
  await Promise.all([
    store.revokeSession("revoked", now + 1),
    store.touchSession("revoked", now + 2, now + 120_000),
  ]);
  expect(await store.findSession("revoked", now + 3)).toBeNull();
  expect(
    await store.revokeAllSessionsForIdentity("owner", now + 3, "retained"),
  ).toBe(0);
  await adapter.close();
  await open();
  expect(await store.findSession("revoked", now + 3)).toBeNull();
  expect(
    (await store.listSessionsForIdentity("owner", now + 3)).map(
      (row) => row.id,
    ),
  ).toEqual(["retained"]);
});
it("rejects wrong-agent selection and malformed stored authorization records", async () => {
  expect(() =>
    authStoreForRuntime({ agentId: randomUUID() as UUID, adapter }),
  ).toThrow(
    expect.objectContaining({ code: "AUTH_RECORD_STORE_AGENT_MISMATCH" }),
  );
  await adapter.recordStore.set("plugin_app_auth_identities_v1", "bad", {
    id: "bad",
    kind: "administrator",
  });
  await expect(store.findIdentity("bad")).rejects.toMatchObject({
    code: "AUTH_RECORD_INVALID",
  });
  expect(authStoreForRuntime(null)).toBeNull();
});
it("uses the selected SQLite store for real HTTP cookie, CSRF and bearer decisions", async () => {
  await identity();
  await identity("device", "machine");
  const browser = await store.createSession(session("browser-token"));
  await store.createSession({
    ...session("machine-token", "device"),
    kind: "machine",
  });
  const current = { agentId, adapter };
  server = createServer((req, res) => {
    void resolveAuthorizedRouteRole(req, {
      state: { current },
      allowTrustedLocalBypass: false,
      now,
    })
      .then((result) => {
        res.writeHead(result.ok ? 200 : result.status, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify(result));
      })
      .catch(() => {
        // error-policy:J1 The real HTTP test boundary returns a distinct unavailable result.
        res.writeHead(503);
        res.end();
      });
  });
  const listening = server;
  await new Promise<void>((resolve) =>
    listening.listen(0, "127.0.0.1", resolve),
  );
  const address = listening.address();
  if (!address || typeof address === "string")
    throw new Error("HTTP test address missing");
  const url = `http://127.0.0.1:${address.port}/auth-test`;
  const cookie = `${SESSION_COOKIE_NAME}=browser-token`;
  expect((await fetch(url, { headers: { cookie } })).status).toBe(200);
  expect(
    (await fetch(url, { method: "POST", headers: { cookie } })).status,
  ).toBe(403);
  expect(
    (
      await fetch(url, {
        method: "POST",
        headers: {
          cookie,
          [CSRF_HEADER_NAME]: deriveCsrfToken(browser),
        },
      })
    ).status,
  ).toBe(200);
  expect(
    await (
      await fetch(url, { headers: { authorization: "Bearer machine-token" } })
    ).json(),
  ).toMatchObject({ ok: true, role: "USER", identityId: "device" });
  await store.revokeSession("machine-token", now);
  expect(
    await resolveSessionTokenRole("machine-token", { state: { current }, now }),
  ).toBeNull();
  expect(
    (await fetch(url, { headers: { authorization: "Bearer machine-token" } }))
      .status,
  ).toBe(401);
});

it.each(["browser", "machine"] as const)(
  "revalidates %s streaming sessions without writes or stale revocation",
  async (kind) => {
    await identity();
    const initial = await store.createSession({
      ...session("stream-session"),
      kind,
    });
    const checkAt = now + 1000;
    for (let index = 0; index < 3; index++) {
      expect(
        await readActiveSession(store, initial.id, checkAt + index),
      ).toEqual(initial);
    }
    expect(await store.findSession(initial.id, checkAt)).toEqual(initial);
    await adapter.close();
    await open();
    expect(await readActiveSession(store, initial.id, checkAt)).toEqual(
      initial,
    );
    const refreshed = await findActiveSession(store, initial.id, checkAt);
    expect(refreshed?.lastSeenAt).toBe(checkAt);
    expect(refreshed?.expiresAt).toBe(
      kind === "browser" ? now + BROWSER_SESSION_TTL_MS : initial.expiresAt,
    );
    await store.revokeSession(initial.id, checkAt + 1);
    expect(await readActiveSession(store, initial.id, checkAt + 2)).toBeNull();
  },
);

it("rejects expired and over-cap sessions during read-only revalidation", async () => {
  await identity();
  await store.createSession(session("expired-stream"));
  expect(
    await readActiveSession(store, "expired-stream", now + 60000),
  ).toBeNull();
  await store.createSession({
    ...session("over-cap-stream"),
    expiresAt: now + BROWSER_SESSION_TTL_MS * 2,
  });
  expect(
    await readActiveSession(
      store,
      "over-cap-stream",
      now + BROWSER_SESSION_TTL_MS,
    ),
  ).toBeNull();
});
