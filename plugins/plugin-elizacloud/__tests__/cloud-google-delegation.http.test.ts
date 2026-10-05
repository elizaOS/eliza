/** Real HTTP + disk PGlite lifecycle. Cloud policy/Google responses are explicit fixtures. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AppDelegationClient } from "@elizaos/cloud-sdk/app-delegation";
import type { UUID } from "@elizaos/core";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/pglite";
import { expect, test } from "vitest";
import { ConnectorCredentialStoreService } from "../../../packages/agent/src/services/connector-credential-store";
import { createVault, inMemoryMasterKey, type Vault } from "../../../packages/auth/src/vault/index";
import { DelegationRecordStore } from "../src/db/delegation-records";
import { CloudGoogleDelegation } from "../src/services/cloud-google-delegation";

test("reviewed delegation survives database restart, rejects owner/replay/rotation and revokes before remote retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloud-delegation-http-")),
    key = randomBytes(32),
    agent = randomUUID() as UUID;
  let pg: PGlite | undefined,
    server: http.Server | undefined,
    now = Date.now(),
    exchanges = 0,
    reads = 0,
    revokeFails = true,
    exchangeFails = false,
    wrongSubject = false;
  let providerOverride:
    | { path: "list" | "detail" | "calendars" | "events"; value: unknown }
    | undefined;
  let grantScopes = ["identity", "google.basic_identity", "google.gmail.triage"];
  const revoked = new Set<string>();
  let rawVault: Vault | undefined, vault: ConnectorCredentialStoreService;
  const closeVault = async () => {
    if (rawVault) await (rawVault as Vault & { close(): Promise<void> }).close();
    rawVault = undefined;
  };
  try {
    server = http.createServer((req, res) => {
      void (async () => {
        let raw = "";
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : null;
        expect(req.headers.authorization).toBe(
          "Basic " + Buffer.from("fixture-client:fixture-secret").toString("base64")
        );
        const path = new URL(req.url!, "http://fixture").pathname,
          token = req.headers["x-app-delegation"];
        const send = (status: number, data: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(data));
        };
        if (path.endsWith("/token")) {
          exchanges++;
          expect(body.redirectUri).toBe("https://phone.invalid/delegation");
          if (exchangeFails) return send(503, { error: "fixture exchange unavailable" });
          return send(200, {
            success: true,
            data: {
              token: "synthetic-token-" + exchanges,
              expiresAt: new Date(now + 7 * 86400000).toISOString(),
              appId: "fixture-app",
              billingEnvironment: "test",
              scopes: grantScopes,
              user: {
                id: wrongSubject ? "other-user" : "cloud-user",
                organizationId: "org",
                email: null,
                name: null,
                emailVerified: true,
              },
            },
          });
        }
        if (!token || revoked.has(String(token))) return send(401, { error: "revoked" });
        if (path.endsWith("/identity"))
          return send(200, {
            success: true,
            data: {
              id: "cloud-user",
              organizationId: "org",
              email: null,
              name: null,
              emailVerified: true,
            },
          });
        if (path.endsWith("/connections"))
          return send(200, {
            success: true,
            data: [
              {
                connectionId: "explicit-connection",
                connected: true,
                identity: { email: "fixture@example.invalid" },
                reason: "connected",
                grantedCapabilities: grantScopes.filter((s) => s !== "identity"),
              },
            ],
          });
        if (path.endsWith("/revoke")) {
          if (revokeFails) return send(503, { error: "fixture unavailable" });
          revoked.add(String(token));
          return send(200, { success: true });
        }
        if (path.endsWith("/request")) {
          reads++;
          expect(body.connectionId).toBe("explicit-connection");
          expect(body.method).toBe("GET");
          expect(body.body).toBeUndefined();
          const url = new URL(body.url);
          const responseKind =
            url.origin === "https://www.googleapis.com"
              ? url.pathname.endsWith("calendarList")
                ? "calendars"
                : "events"
              : url.pathname.endsWith("/messages")
                ? "list"
                : "detail";
          if (providerOverride?.path === responseKind) return send(200, providerOverride.value);
          if (url.origin === "https://www.googleapis.com") {
            return send(
              200,
              url.pathname.endsWith("calendarList")
                ? { items: [{ id: "explicit-calendar", summary: "Calendar" }] }
                : {
                    items: [
                      {
                        id: "event1",
                        summary: "Fixture event",
                        start: { dateTime: new Date(now).toISOString() },
                        end: { dateTime: new Date(now + 3600000).toISOString() },
                      },
                    ],
                  }
            );
          }
          expect(url.origin).toBe("https://gmail.googleapis.com");
          return send(
            200,
            url.pathname.endsWith("/messages")
              ? { messages: [{ id: "mail1" }] }
              : {
                  id: "mail1",
                  snippet: "fixture snippet",
                  internalDate: String(now),
                  payload: { headers: [{ name: "Subject", value: "fixture subject" }] },
                }
          );
        }
        send(404, {});
      })().catch((e) => {
        res.writeHead(500);
        res.end(String(e));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const origin = "http://127.0.0.1:" + (server.address() as any).port;
    const config = {
      appId: "fixture-app",
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      redirectUri: "https://phone.invalid/delegation",
      siteUrl: "https://cloud.invalid",
      apiBaseUrl: "https://cloud.invalid/api/v1",
    };
    const client = new AppDelegationClient({
      ...config,
      fetchImpl: (input, init) => fetch(origin + new URL(String(input)).pathname, init),
    });
    const open = async () => {
      rawVault = createVault({
        workDir: join(directory, "vault"),
        masterKey: inMemoryMasterKey(Buffer.from(key)),
      });
      vault = new ConnectorCredentialStoreService(undefined, rawVault);
      pg = new PGlite(join(directory, "database"));
      await pg.exec(
        "CREATE SCHEMA IF NOT EXISTS cloud_delegation; CREATE TABLE IF NOT EXISTS cloud_delegation.records(agent_id text NOT NULL,namespace text NOT NULL,key text NOT NULL,value jsonb NOT NULL,PRIMARY KEY(agent_id,namespace,key))"
      );
      const store = new DelegationRecordStore(agent, drizzle(pg) as unknown as NodePgDatabase);
      return { store, engine: new CloudGoogleDelegation(store, vault, config, client, () => now) };
    };
    let { engine, store } = await open();
    const owner = { ownerId: "local-owner", cloudUserId: "cloud-user" };
    const begin = await engine.begin(owner, { confirmed: true, kinds: ["email"] });
    const state = new URL(begin.authUrl).searchParams.get("state")!;
    expect(new URL(begin.authUrl).searchParams.get("scopes")).not.toContain("send");
    await expect(
      engine.complete(
        { ownerId: "other", cloudUserId: "cloud-user" },
        { state, code: "fixture-code" }
      )
    ).rejects.toThrow();
    const outcomes = await Promise.allSettled([
      engine.complete(owner, { state, code: "fixture-code" }),
      engine.complete(owner, { state, code: "fixture-code" }),
    ]);
    expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(exchanges).toBe(1);
    expect(await engine.status(owner, { state })).toMatchObject({ status: "complete" });
    const grant = (outcomes.find((x) => x.status === "fulfilled") as PromiseFulfilledResult<any>)
      .value;
    expect(JSON.stringify(await store.getAll("eliza_cloud_google_delegation_v1"))).not.toContain(
      "synthetic-token"
    );
    expect((await engine.list("other")).accounts).toHaveLength(0);
    const account = (await engine.list(owner.ownerId)).accounts[0];
    expect(account.kinds).toEqual(["email"]);
    const selection = { ...account, kind: "email" as const, windowHours: 24, maxItems: 10 };
    expect(await engine.read(owner.ownerId, selection, now)).toMatchObject([
      { subject: "fixture subject", snippet: "fixture snippet" },
    ]);
    for (const value of [
      null,
      [],
      { messages: null },
      { messages: [null] },
      { messages: [{ id: 1 }] },
      { messages: Array(11).fill({ id: "mail1" }) },
    ]) {
      providerOverride = { path: "list", value };
      await expect(engine.read(owner.ownerId, selection, now)).rejects.toThrow();
    }
    providerOverride = { path: "list", value: {} };
    expect(await engine.read(owner.ownerId, selection, now)).toEqual([]);
    for (const value of [
      null,
      [],
      { snippet: {} },
      { payload: null },
      { payload: { headers: {} } },
      { payload: { headers: [null] } },
      { payload: { headers: [{ name: 1 }] } },
      { internalDate: "999999999999999999999" },
      { internalDate: {} },
    ]) {
      providerOverride = { path: "detail", value };
      await expect(engine.read(owner.ownerId, selection, now)).rejects.toThrow();
    }
    providerOverride = { path: "detail", value: {} };
    expect(await engine.read(owner.ownerId, selection, now)).toMatchObject([
      { id: "mail1", receivedAt: "" },
    ]);
    providerOverride = undefined;
    await pg.close();
    await closeVault();
    ({ engine, store } = await open());
    expect(await engine.read(owner.ownerId, selection, now)).toMatchObject([
      { subject: "fixture subject" },
    ]);
    const before = reads;
    expect(
      await engine.revoke(owner.ownerId, { grantId: grant.grantId, confirmed: true })
    ).toMatchObject({ revoked: true, remoteRevocation: "retry_required" });
    await pg.close();
    await closeVault();
    ({ engine, store } = await open());
    expect(await engine.revocations(owner.ownerId)).toMatchObject({
      grants: [{ grantId: grant.grantId }],
    });
    expect(await engine.revocations("other")).toEqual({ grants: [] });
    await expect(engine.read(owner.ownerId, selection, now)).rejects.toThrow();
    expect(reads).toBe(before);
    revokeFails = false;
    expect(
      await engine.revoke(owner.ownerId, { grantId: grant.grantId, confirmed: true })
    ).toMatchObject({ remoteRevocation: "confirmed" });
    expect(await engine.revocations(owner.ownerId)).toEqual({ grants: [] });
    wrongSubject = true;
    const bad = await engine.begin(owner, { confirmed: true, kinds: ["email"] });
    await expect(
      engine.complete(owner, {
        state: new URL(bad.authUrl).searchParams.get("state"),
        code: "wrong-subject",
      })
    ).rejects.toThrow();
    expect((await engine.list(owner.ownerId)).accounts).toHaveLength(0);
    wrongSubject = false;
    const next = await engine.begin(owner, { confirmed: true, kinds: ["email"] });
    await engine.complete(owner, {
      state: new URL(next.authUrl).searchParams.get("state"),
      code: "new-fixture",
    });
    const nextAccount = (await engine.list(owner.ownerId)).accounts[0];
    const rotated = new CloudGoogleDelegation(
      store,
      vault,
      { ...config, clientSecret: "rotated" },
      client,
      () => now
    );
    expect((await rotated.list(owner.ownerId)).accounts).toHaveLength(0);
    grantScopes = ["identity", "google.basic_identity", "google.calendar.read"];
    const calendarStart = await engine.begin(owner, { confirmed: true, kinds: ["calendar"] });
    await engine.complete(owner, {
      state: new URL(calendarStart.authUrl).searchParams.get("state"),
      code: "calendar-fixture",
    });
    const calendarAccount = (await engine.list(owner.ownerId)).accounts.find((a) =>
      a.kinds.includes("calendar")
    )!;
    expect(
      await engine.calendars(
        owner.ownerId,
        calendarAccount.accountId,
        calendarAccount.accountRevision
      )
    ).toMatchObject({ calendars: [{ calendarId: "explicit-calendar" }] });
    expect(
      await engine.read(
        owner.ownerId,
        {
          ...calendarAccount,
          kind: "calendar",
          calendarId: "explicit-calendar",
          windowHours: 24,
          maxItems: 10,
        },
        now
      )
    ).toMatchObject({ events: [{ title: "Fixture event" }] });
    const calendarSelection = {
      ...calendarAccount,
      kind: "calendar" as const,
      calendarId: "explicit-calendar",
      windowHours: 24,
      maxItems: 10,
    };
    for (const value of [
      null,
      [],
      { items: null },
      { items: [null] },
      { items: [{ id: "c", timeZone: {} }] },
      { items: [], nextPageToken: 2 },
      { items: Array(51).fill({ id: "c" }) },
    ]) {
      providerOverride = { path: "calendars", value };
      await expect(
        engine.calendars(owner.ownerId, calendarAccount.accountId, calendarAccount.accountRevision)
      ).rejects.toThrow();
    }
    for (const value of [
      null,
      [],
      { items: [null] },
      { items: [{ id: "e", start: null }] },
      { items: [{ id: "e", end: { date: 1 } }] },
      { items: [{ id: "e", summary: {} }] },
      { items: [], nextPageToken: [] },
      { items: Array(11).fill({ id: "e" }) },
    ]) {
      providerOverride = { path: "events", value };
      await expect(engine.read(owner.ownerId, calendarSelection, now)).rejects.toThrow();
    }
    providerOverride = {
      path: "events",
      value: {
        items: [{ id: "all-day", start: { date: "2026-09-30" }, end: { date: "2026-10-01" } }],
        nextPageToken: "next",
      },
    };
    expect(await engine.read(owner.ownerId, calendarSelection, now)).toMatchObject({
      events: [{ id: "all-day", start: "2026-09-30", end: "2026-10-01" }],
      nextPageToken: "next",
    });
    providerOverride = undefined;
    const cancelStart = await engine.begin(owner, { confirmed: true, kinds: ["calendar"] });
    const cancelState = new URL(cancelStart.authUrl).searchParams.get("state");
    await engine.cancel(owner, { state: cancelState, confirmed: true });
    expect(await engine.status(owner, { state: cancelState })).toEqual({ status: "failed" });
    const unavailableStart = await engine.begin(owner, { confirmed: true, kinds: ["calendar"] });
    const unavailableState = new URL(unavailableStart.authUrl).searchParams.get("state");
    exchangeFails = true;
    await expect(
      engine.complete(owner, { state: unavailableState, code: "unavailable-code" })
    ).rejects.toThrow();
    expect(await engine.status(owner, { state: unavailableState })).toEqual({ status: "failed" });
    const exchangesAfterFailure = exchanges;
    await expect(
      engine.complete(owner, { state: unavailableState, code: "unavailable-code" })
    ).rejects.toThrow();
    expect(exchanges).toBe(exchangesAfterFailure);
    exchangeFails = false;
    now += 7 * 86400000 + 1;
    await expect(
      engine.read(owner.ownerId, { ...selection, ...nextAccount }, now)
    ).rejects.toThrow();
  } finally {
    await closeVault();
    await pg?.close();
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("app HTTP gate requires a persisted Cloud owner session", async () => {
  const { authStoreForRuntime } = await import("../../../packages/app/src/services/auth-store");
  const { handleCloudGoogleDelegationRoute } = await import(
    "../../../packages/app/src/api/cloud-google-delegation-routes"
  );
  const { enforceCompatRouteAuthPolicy } = await import(
    "../../../packages/app/src/api/route-auth-policy"
  );
  const pg = new PGlite();
  await pg.exec(
    "CREATE SCHEMA cloud_delegation; CREATE TABLE cloud_delegation.records(agent_id text NOT NULL,namespace text NOT NULL,key text NOT NULL,value jsonb NOT NULL,PRIMARY KEY(agent_id,namespace,key))"
  );
  const records = new DelegationRecordStore(
    randomUUID() as UUID,
    drizzle(pg) as unknown as NodePgDatabase
  );
  let calls = 0;
  const runtime = {
    agentId: records.agentId,
    adapter: { recordStore: records },
    getService: () => ({
      begin: async (principal: unknown) => {
        calls++;
        return { principal };
      },
    }),
  } as any;
  const store = authStoreForRuntime(runtime)!;
  const now = Date.now();
  for (const [id, cloudUserId] of [
    ["cloud-owner", "cloud-user"],
    ["local-owner", null],
  ] as const) {
    await store.createIdentity({ id, kind: "owner", displayName: id, createdAt: now, cloudUserId });
    await store.createSession({
      id: "session-" + id,
      identityId: id,
      kind: "browser",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + 60000,
      rememberDevice: false,
      csrfSecret: "fixture",
      ip: null,
      userAgent: null,
      scopes: [],
    });
  }
  const server = http.createServer((req, res) => {
    void (async () => {
      const decision = await enforceCompatRouteAuthPolicy(
        req,
        res,
        { current: runtime } as any,
        req.method!,
        new URL(req.url!, "http://fixture").pathname
      );
      if (decision === "allowed") await handleCloudGoogleDelegationRoute(req, res, runtime);
      else if (decision === "unmanaged") {
        res.writeHead(404);
        res.end();
      }
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" +
    (server.address() as any).port +
    "/api/workflow/hosted/cloud-delegation/start";
  try {
    const request = (token?: string, extra: Record<string, string> = {}) =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: "Bearer " + token } : {}),
          ...extra,
        },
        body: JSON.stringify({ confirmed: true, kinds: ["email"] }),
      });
    expect((await request()).status).toBeGreaterThanOrEqual(400);
    expect((await request("session-local-owner")).status).toBe(403);
    expect(
      (await request("session-cloud-owner", { "x-eliza-cloud-owner-proof": "invalid" })).status
    ).toBe(401);
    const result = await request("session-cloud-owner");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({
      principal: { ownerId: "cloud-owner", cloudUserId: "cloud-user" },
    });
    expect(calls).toBe(1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pg.close();
  }
}, 120000);
