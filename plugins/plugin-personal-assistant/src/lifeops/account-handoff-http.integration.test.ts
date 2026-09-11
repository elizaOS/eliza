/** Real loopback HTTP, owner gate and PGlite review round-trip; Google discovery is deterministic and no provider mutation or message occurs. */

import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { getConnectorAccountManager, stringToUuid } from "@elizaos/core";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { googleHandoffFixture } from "../../test/helpers/handoff-google.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import { GoogleWorkspaceTestService } from "../../test/stubs/plugin-google-workspace.js";
import { personalAssistantRoutesPlugin } from "../routes/plugin.js";
import { AccountHandoffStore } from "./account-handoff-store.js";

let host: RealTestRuntimeResult;
let server: Server;
let baseUrl: string;
const owner = stringToUuid("handoff-http-owner");
const otherOwner = stringToUuid("handoff-http-other-owner");
const token = "synthetic-handoff-http-owner-token";
const serverErrors: Error[] = [];
const choices = {
  operationId: "http-review",
  previousGrantId: "connector-account:http-old",
  replacementGrantId: "connector-account:http-new",
  readCalendarIds: ["reviewed-calendar"],
  writeCalendarId: null,
  calendarLinks: [],
  messageDestinations: [
    {
      channel: "email",
      connectorAccountId: "http-new",
      recipientId: "recipient@example.test",
      recipientEntityId: owner,
    },
  ],
  importedData: "retain",
  retireApprovalIds: [],
};

beforeAll(async () => {
  vi.stubEnv("ELIZA_API_TOKEN", token);
  vi.stubEnv("ELIZA_REQUIRE_LOCAL_AUTH", "1");
  host = await createLifeOpsTestRuntime();
  host.runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", owner);
  await host.runtime.registerService(GoogleWorkspaceTestService);
  const provider = await host.runtime.getServiceLoadPromise("google");
  Object.assign(provider, {
    listCalendars: async () => [googleHandoffFixture().entry],
  });
  const manager = getConnectorAccountManager(host.runtime);
  manager.registerProvider({ provider: "google" });
  for (const id of ["http-old", "http-new"]) {
    const saved = await manager.upsertAccount("google", {
      id,
      provider: "google",
      role: "OWNER",
      purpose: ["reading"],
      accessGate: "owner_binding",
      status: "connected",
      displayHandle: `${id}@example.test`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: {
        grantedScopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/gmail.send",
        ],
      },
    });
    if (id === "http-old")
      choices.previousGrantId = `connector-account:${saved.id}`;
    else {
      choices.replacementGrantId = `connector-account:${saved.id}`;
      const destination = choices.messageDestinations[0];
      if (!destination) throw new Error("Fixture recipient missing");
      destination.connectorAccountId = saved.id;
    }
  }
  const graph = resolveKnowledgeGraphService(host.runtime);
  if (!graph) throw new Error("Fixture graph missing");
  await graph.getEntityStore(host.runtime.agentId).upsert({
    entityId: owner,
    type: "person",
    preferredName: "Synthetic recipient",
    identities: [
      {
        platform: "email",
        handle: "recipient@example.test",
        connectorAccountId: "default",
        verified: true,
        confidence: 1,
        addedAt: "2026-09-01T00:00:00Z",
        addedVia: "user_chat",
        evidence: ["Synthetic confirmation"],
      },
    ],
    tags: [],
    visibility: "owner_only",
    state: {},
  });
  server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const path =
      pathname === "/api/lifeops/account-handoffs" ||
      pathname.endsWith("/active")
        ? pathname
        : pathname.endsWith("/cancel")
          ? "/api/lifeops/account-handoffs/:operationId/cancel"
          : "/api/lifeops/account-handoffs/:operationId";
    const route = personalAssistantRoutesPlugin.routes?.find(
      (item) => item.type === req.method && item.path === path,
    );
    if (!route?.handler) {
      res.writeHead(404).end();
      return;
    }
    Promise.resolve(
      route.handler(req as never, res as never, host.runtime as never),
    ).catch((error) => {
      // error-policy:J1 Test HTTP boundary records unexpected failures before closing the response.
      serverErrors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
      res.writeHead(500).end("Unexpected test server failure");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture server address missing");
  baseUrl = `http://127.0.0.1:${address.port}/api/lifeops/account-handoffs`;
}, 60_000);
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (host) await host.cleanup();
  vi.unstubAllEnvs();
});

it("rejects unauthenticated requests and malformed approval IDs before a saved review exists", async () => {
  const denied = await fetch(`${baseUrl}/active`, {
    headers: { "x-eliza-entity-id": owner },
  });
  expect(denied.status).toBe(401);
  const invalid = await fetch(baseUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...choices, retireApprovalIds: ["invalid-id"] }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({
    code: "ACCOUNT_HANDOFF_INVALID_REVIEW",
  });
  expect(
    await new AccountHandoffStore(host.runtime, owner).active(),
  ).toBeNull();
});

it("creates and replays a review through canonical services and ignores forged owner headers during readback", async () => {
  const post = () =>
    fetch(baseUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(choices),
    });
  const created = await post();
  const payload = await created.json();
  expect(created.status, JSON.stringify(payload)).toBe(200);
  expect(payload.handoff.review.replacement.email).toBe(
    "http-new@example.test",
  );
  expect(payload.handoff.phase).toBe("reviewed");
  const replay = await post();
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(payload);
  const active = await fetch(`${baseUrl}/active`, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-eliza-entity-id": otherOwner,
    },
  });
  expect(active.status).toBe(200);
  expect(await active.json()).toEqual(payload);
  const read = await fetch(`${baseUrl}/http-review`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await read.json()).toEqual(payload);
  expect(
    await new AccountHandoffStore(host.runtime, otherOwner).read("http-review"),
  ).toBeNull();
  expect(serverErrors).toEqual([]);
});

it("cancels only an unchanged unstarted review and permits replay without another transition", async () => {
  const store = new AccountHandoffStore(host.runtime, owner);
  const review = await store.read("http-review");
  if (!review) throw new Error("Fixture review missing");
  const cancel = (expectedRevision: number) =>
    fetch(`${baseUrl}/http-review/cancel`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expectedRevision }),
    });
  expect((await cancel(review.revision - 1)).status).toBe(409);
  expect(await store.read(review.operationId)).toEqual(review);
  const response = await cancel(review.revision);
  expect(response.status).toBe(200);
  const cancelled = await response.json();
  expect(cancelled.handoff.phase).toBe("cancelled");
  expect(await store.active()).toBeNull();
  expect(await (await cancel(review.revision)).json()).toEqual(cancelled);
  const next = await store.review("http-started", review.review);
  const started = await store.advance({
    operationId: next.operationId,
    expectedRevision: next.revision,
    expectedPhase: "reviewed",
    phase: "pausing",
    receipt: {},
  });
  const refused = await fetch(`${baseUrl}/http-started/cancel`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: started.revision }),
  });
  expect(refused.status).toBe(409);
  expect(await store.read(started.operationId)).toEqual(started);
  expect(serverErrors).toEqual([]);
});
