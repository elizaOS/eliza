/**
 * PATCH /api/lifeops/entities/:id and /relationships/:id must not write back a
 * copy read before the request body arrived: a concurrent graph write made
 * while the body is in flight (a new identity, an observed interaction) has to
 * survive. Deterministic: an in-memory store with get/upsert/patch, and a
 * request body released only after the concurrent write.
 */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import type { AgentRuntime } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { handleEntityRoutes } from "./entities.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";
import { handleRelationshipRoutes } from "./relationships.js";

type Row = Record<string, unknown>;

const stores = vi.hoisted(() => {
  const memoryStore = (key: string) => {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      rows,
      async get(id: string) {
        const row = rows.get(id);
        return row ? structuredClone(row) : null;
      },
      async upsert(input: Record<string, unknown>) {
        const id = String(input[key]);
        rows.set(id, structuredClone(input));
        return structuredClone(input);
      },
      async patch(
        id: string,
        mutate: (row: Record<string, unknown>) => Record<string, unknown>,
      ) {
        const row = rows.get(id);
        if (!row) return null;
        const next = mutate(structuredClone(row));
        rows.set(id, structuredClone(next));
        return structuredClone(next);
      },
    };
  };
  return {
    entities: memoryStore("entityId"),
    relationships: memoryStore("relationshipId"),
  };
});

vi.mock("@elizaos/plugin-relationships", () => ({
  resolveKnowledgeGraphService: () => ({
    getEntityStore: () => stores.entities,
    getRelationshipStore: () => stores.relationships,
  }),
}));

function patchRequest(pathname: string, body: Promise<Row>) {
  const res: { statusCode?: number; body?: string } = {};
  const httpReq = new IncomingMessage(new Socket());
  httpReq.method = "PATCH";
  const httpRes = new ServerResponse(httpReq);
  const ctx = {
    req: httpReq,
    res: httpRes,
    method: "PATCH",
    pathname,
    url: new URL(`http://localhost${pathname}`),
    state: {
      runtime: { agentId: "agent-1" } as unknown as AgentRuntime,
      adminEntityId: null,
    },
    json(_r: unknown, data: unknown, status = 200) {
      res.statusCode = status;
      res.body = JSON.stringify(data);
    },
    error(_r: unknown, message: string, status = 400) {
      res.statusCode = status;
      res.body = JSON.stringify({ error: message });
    },
    readJsonBody: async () => body,
    decodePathComponent: (raw: string) => decodeURIComponent(raw),
  } as unknown as LifeOpsRouteContext;
  return { ctx, res };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

it("keeps an identity observed while the entity PATCH body was in flight", async () => {
  stores.entities.rows.set("ent_1", {
    entityId: "ent_1",
    preferredName: "Pat",
    identities: [{ platform: "telegram", handle: "@pat" }],
    state: {},
  });
  const body = deferred<Row>();
  const { ctx, res } = patchRequest(
    "/api/lifeops/entities/ent_1",
    body.promise,
  );

  const handled = handleEntityRoutes(ctx);
  await flush();
  // A message from Pat on another platform lands mid-request.
  const current = stores.entities.rows.get("ent_1") as Row;
  stores.entities.rows.set("ent_1", {
    ...current,
    identities: [
      { platform: "telegram", handle: "@pat" },
      { platform: "discord", handle: "pat#1" },
    ],
  });
  body.resolve({ preferredName: "Patricia" });
  await handled;

  expect(res.statusCode).toBe(200);
  expect(stores.entities.rows.get("ent_1")).toMatchObject({
    preferredName: "Patricia",
    identities: [
      { platform: "telegram", handle: "@pat" },
      { platform: "discord", handle: "pat#1" },
    ],
  });
});

it("keeps an interaction observed while the relationship PATCH body was in flight", async () => {
  stores.relationships.rows.set("rel_1", {
    relationshipId: "rel_1",
    fromEntityId: "self",
    toEntityId: "ent_1",
    type: "knows",
    status: "active",
    state: { interactionCount: 5 },
  });
  const body = deferred<Row>();
  const { ctx, res } = patchRequest(
    "/api/lifeops/relationships/rel_1",
    body.promise,
  );

  const handled = handleRelationshipRoutes(ctx);
  await flush();
  const current = stores.relationships.rows.get("rel_1") as Row;
  stores.relationships.rows.set("rel_1", {
    ...current,
    state: { interactionCount: 6 },
  });
  body.resolve({ confidence: 0.9 });
  await handled;

  expect(res.statusCode).toBe(200);
  expect(stores.relationships.rows.get("rel_1")).toMatchObject({
    confidence: 0.9,
    state: { interactionCount: 6 },
  });
});

it("answers 404 for an unknown entity without writing", async () => {
  const { ctx, res } = patchRequest(
    "/api/lifeops/entities/ent_missing",
    Promise.resolve({ preferredName: "Nobody" }),
  );
  await handleEntityRoutes(ctx);
  expect(res.statusCode).toBe(404);
  expect(stores.entities.rows.has("ent_missing")).toBe(false);
});
