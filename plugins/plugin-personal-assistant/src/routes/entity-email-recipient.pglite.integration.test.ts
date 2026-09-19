/**
 * Exercises owner contact creation through registered HTTP routes and the real
 * family email consumer against PGlite, with distinct actor and agent identities.
 * Contacts and co-parent edges must reach the same agent graph; legacy actor
 * records remain preserved and are never implicitly copied across agents.
 */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { resolveKnowledgeGraphService } from "@elizaos/agent";
import { AuthStore } from "@elizaos/app-core/services/auth-store";
import { resolveOwnerEntityIdOrDefault } from "@elizaos/core";
import { expect, it } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createMachineSession } from "../../../../packages/app-core/src/api/auth/sessions.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import { FamilyWorkflowRuntimeService } from "../lifeops/family-workflows/runtime.js";

it("makes owner-created contacts available to family email without crossing agent partitions", async () => {
  const host = await createLifeOpsTestRuntime();
  const runtime = host.runtime;
  expect(resolveOwnerEntityIdOrDefault(runtime)).not.toBe(runtime.agentId);
  const graph = resolveKnowledgeGraphService(runtime);
  if (!graph) throw new Error("Knowledge graph did not initialize");
  const auth = new AuthStore(
    runtime.adapter.db as ConstructorParameters<typeof AuthStore>[0],
  );
  const identityId = randomUUID();
  await auth.createIdentity({
    id: identityId,
    kind: "machine",
    displayName: "Synthetic non-owner",
    createdAt: Date.now(),
    passwordHash: null,
    cloudUserId: null,
  });
  const { session: guestSession } = await createMachineSession(auth, {
    identityId,
    scopes: [],
  });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () =>
        req.headers.authorization === "Bearer owner-test" ||
        req.headers.authorization === `Bearer ${guestSession.id}`,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server did not bind TCP");
    const base = `http://127.0.0.1:${address.port}/api/lifeops`;
    const headers = {
      authorization: "Bearer owner-test",
      "content-type": "application/json",
    };
    const payload = {
      type: "person",
      preferredName: "Synthetic email recipient",
      visibility: "owner_only",
      identities: [
        {
          platform: "email",
          handle: "owner@example.test",
          verified: true,
          confidence: 1,
          addedAt: new Date().toISOString(),
          addedVia: "user_chat" as const,
          evidence: [],
        },
      ],
    };
    const legacyStore = graph.getEntityStore(
      resolveOwnerEntityIdOrDefault(runtime),
    );
    const legacy = await legacyStore.upsert({
      type: "person",
      preferredName: "Legacy owner contact requiring review",
      identities: payload.identities,
      tags: ["legacy-reviewed"],
      state: {},
      visibility: "owner_only",
    });
    await graph.getEntityStore(runtime.agentId).ensureSelf();
    const legacyRelationships = graph.getRelationshipStore(
      resolveOwnerEntityIdOrDefault(runtime),
    );
    const legacyRelationship = await legacyRelationships.upsert({
      fromEntityId: "self",
      toEntityId: legacy.entityId,
      type: "co_parent",
      state: {},
      evidence: ["owner-created"],
      confidence: 1,
      source: "user_chat",
    });
    const denied = await fetch(`${base}/entities`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(denied.status).toBe(401);
    const created = await fetch(`${base}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(200);
    const saved = (await created.json()).entity;
    const secondResponse = await fetch(`${base}/entities`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "person",
        preferredName: "Synthetic co-parent",
        visibility: "owner_only",
      }),
    });
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()).entity;
    const relationshipResponse = await fetch(`${base}/relationships`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fromEntityId: saved.entityId,
        toEntityId: second.entityId,
        type: "co_parent",
        source: "user_chat",
      }),
    });
    expect(relationshipResponse.status).toBe(200);
    const relationship = (await relationshipResponse.json()).relationship;
    expect(
      await graph
        .getRelationshipStore(runtime.agentId)
        .get(relationship.relationshipId),
    ).toMatchObject({
      fromEntityId: saved.entityId,
      toEntityId: second.entityId,
      type: "co_parent",
    });
    expect(
      await graph
        .getRelationshipStore("another-agent")
        .get(relationship.relationshipId),
    ).toBeNull();
    const options = await fetch(`${base}/family-workflows/email-options`, {
      headers,
    });
    expect(options.status).toBe(200);
    expect((await options.json()).options.recipients).toContainEqual({
      entityId: saved.entityId,
      name: payload.preferredName,
      address: "owner@example.test",
    });
    expect(
      await graph.getEntityStore(runtime.agentId).get(saved.entityId),
    ).toMatchObject({
      entityId: saved.entityId,
      preferredName: payload.preferredName,
    });
    expect(
      await graph.getEntityStore("another-agent").get(saved.entityId),
    ).toBeNull();
    await expect(
      new FamilyWorkflowRuntimeService(runtime).validateRecipientIdentity({
        recipientEntityId: saved.entityId,
        recipient: "owner@example.test",
        email: {
          senderGrantId: "unselected-test-grant",
          subject: "Synthetic identity validation only",
        },
      }),
    ).resolves.toBeUndefined();
    expect(await legacyStore.get(legacy.entityId)).toEqual(legacy);
    expect(
      await graph.getEntityStore(runtime.agentId).get(legacy.entityId),
    ).toBeNull();
    const legacyRead = await fetch(`${base}/entities/${legacy.entityId}`, {
      headers,
    });
    expect(legacyRead.status).toBe(404);
    const guestHeaders = {
      "content-type": "application/json",
      Host: "family.example.test",
      "x-forwarded-for": "203.0.113.20",
      authorization: `Bearer ${guestSession.id}`,
      "x-eliza-entity-id": "self",
    };
    for (const path of [
      `entities/${saved.entityId}`,
      "entities/legacy-owner-graph",
      "family-workflows/email-options",
    ]) {
      expect(
        (await fetch(`${base}/${path}`, { headers: guestHeaders })).status,
      ).toBe(403);
    }
    for (const path of [
      "entities",
      "entities/legacy-owner-graph",
      "relationships",
    ]) {
      expect(
        (
          await fetch(`${base}/${path}`, {
            method: "POST",
            headers: guestHeaders,
            body: JSON.stringify(payload),
          })
        ).status,
      ).toBe(403);
    }
    const legacyPath = `${base}/entities/legacy-owner-graph`;
    expect((await fetch(legacyPath)).status).toBe(401);
    const previewResponse = await fetch(legacyPath, { headers });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json();
    expect(preview.sourcePartition).toBe(
      resolveOwnerEntityIdOrDefault(runtime),
    );
    expect(preview.targetPartition).toBe(runtime.agentId);
    const changed = await legacyStore.upsert({
      ...legacy,
      preferredName: "Reviewed legacy recipient",
    });
    const stale = await fetch(legacyPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewSha256: preview.reviewSha256 }),
    });
    expect(stale.status).toBe(409);
    expect(
      await graph.getEntityStore(runtime.agentId).get(legacy.entityId),
    ).toBeNull();
    const current = await (await fetch(legacyPath, { headers })).json();
    await graph
      .getEntityStore(runtime.agentId)
      .upsert({ ...changed, preferredName: "Unrelated existing record" });
    const collision = await fetch(legacyPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewSha256: current.reviewSha256 }),
    });
    expect(collision.status).toBe(409);
    expect(await legacyStore.get(legacy.entityId)).toEqual(changed);
    await graph.getEntityStore(runtime.agentId).deleteForTest(legacy.entityId);
    const attempts = await Promise.all(
      [1, 2].map(() =>
        fetch(legacyPath, {
          method: "POST",
          headers,
          body: JSON.stringify({ reviewSha256: current.reviewSha256 }),
        }),
      ),
    );
    expect(attempts.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const adopted = attempts.find((response) => response.status === 200);
    if (!adopted) throw new Error("Neither adoption completed");
    expect(adopted.status).toBe(200);
    expect((await adopted.json()).adopted).toBe(true);
    expect(
      await graph.getEntityStore(runtime.agentId).get(legacy.entityId),
    ).toEqual(changed);
    expect(await legacyStore.get(legacy.entityId)).toBeNull();
    expect(
      await graph
        .getRelationshipStore(runtime.agentId)
        .get(legacyRelationship.relationshipId),
    ).toEqual(legacyRelationship);
    expect(
      await legacyRelationships.get(legacyRelationship.relationshipId),
    ).toBeNull();
    expect(
      await graph.getEntityStore("another-agent").get(legacy.entityId),
    ).toBeNull();
    const replay = await fetch(legacyPath, {
      method: "POST",
      headers,
      body: JSON.stringify({ reviewSha256: current.reviewSha256 }),
    });
    expect(replay.status).toBe(409);
    const readDenied = await fetch(`${base}/entities/${saved.entityId}`);
    expect(readDenied.status).toBe(401);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await host.cleanup();
  }
}, 180000);
