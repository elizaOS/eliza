/**
 * Route-level tests for pendant session sync using the repository contract.
 *
 * The runtime wrapper deliberately throws on Memory API access; pendant capture
 * state belongs to normalized session/segment/insight tables instead.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryPendantSessionRepository,
  type PendantSessionRepository,
  PendantSessionRevisionConflictError,
  type StoredPendantSessionDocument,
} from "../services/pendant-session/repository.ts";

type UUID = `${string}-${string}-${string}-${string}-${string}`;

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => ({}),
}));

vi.mock("./views-routes.ts", () => ({
  getViewsBroadcastWs: () => null,
}));

vi.mock("@elizaos/core", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
  readJsonBody: vi.fn(),
  resolveCanonicalOwnerId: (runtime: {
    getSetting?: (key: string) => unknown;
  }) => runtime.getSetting?.("ELIZA_ADMIN_ENTITY_ID") ?? null,
  sendJson: vi.fn(),
  stringToUuid: (value: string) => {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const seed = (hash >>> 0).toString(16).padStart(8, "0");
    return `${seed}-${seed.slice(0, 4)}-4${seed.slice(1, 4)}-a${seed.slice(1, 4)}-${seed}${seed.slice(0, 4)}`;
  },
}));

const {
  buildPendantSessionRouteContext,
  handlePendantSessionRoutes,
  subscribePendantCommittedSegments,
} = await import("./pendant-session-routes");

class TestRuntime {
  readonly agentId: UUID;
  readonly character = { name: "Test Agent" };
  readonly memories = new Map<string, Record<string, unknown>>();
  readonly createMemory = vi.fn(
    async (memory: Record<string, unknown>, tableName: string) => {
      this.memories.set(String(memory.id), memory);
      expect(tableName).toBe("messages");
      return memory.id;
    },
  );
  readonly updateMemory = vi.fn(async (memory: Record<string, unknown>) => {
    this.memories.set(String(memory.id), memory);
  });

  constructor(agentId: UUID) {
    this.agentId = agentId;
  }

  get adapter(): never {
    throw new Error(
      "Pendant session routes must not use runtime.adapter directly in tests",
    );
  }

  async getMemoryById(id: string): Promise<Record<string, unknown> | null> {
    return this.memories.get(id) ?? null;
  }
}

interface RouteResult {
  status: number;
  body: unknown;
}

function uuid(): UUID {
  return crypto.randomUUID() as UUID;
}

function makeHarness(
  ownerId = uuid(),
  repository: PendantSessionRepository = new InMemoryPendantSessionRepository(),
  agentId = uuid(),
) {
  const runtime = new TestRuntime(agentId);
  const broadcastWs = vi.fn();
  const state = {
    runtime: runtime as never,
    adminEntityId: ownerId,
    broadcastWs,
    pendantSessionRepository: repository,
  };

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RouteResult> {
    const url = new URL(`http://127.0.0.1${path}`);
    let result: RouteResult | null = null;
    const handled = await handlePendantSessionRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname: url.pathname,
      url,
      state,
      readJsonBody: async <T>() => (body ?? {}) as T,
      json: (_res, data, status = 200) => {
        result = { status, body: data };
      },
    });
    expect(handled).toBe(true);
    if (!result) throw new Error("route did not write a response");
    return result;
  }

  return { request, runtime, state, broadcastWs, repository };
}

function okBody<T>(result: RouteResult): T {
  expect(result.status).toBeGreaterThanOrEqual(200);
  expect(result.status).toBeLessThan(300);
  return result.body as T;
}

function segment(
  _sessionId: string,
  ordinal: number,
  revision = 0,
  text = `segment ${ordinal}`,
) {
  return {
    ordinal,
    status: "resolved",
    text,
    words: [
      { word: text, startMs: ordinal * 1000, endMs: ordinal * 1000 + 500 },
    ],
    speakerCluster: null,
    speakerAlias: null,
    confidence: 0.9,
    error: null,
    startedAt: "2026-07-09T00:00:00.000Z",
    endedAt: "2026-07-09T00:00:01.000Z",
    revision,
  };
}

class FailingPendantSessionRepository implements PendantSessionRepository {
  constructor(
    private readonly delegate = new InMemoryPendantSessionRepository(),
    private readonly fail: Partial<
      Record<keyof PendantSessionRepository, boolean>
    > = {},
  ) {}

  async load(
    params: Parameters<PendantSessionRepository["load"]>[0],
  ): ReturnType<PendantSessionRepository["load"]> {
    if (this.fail.load) throw new Error("load failed");
    return this.delegate.load(params);
  }

  async create(stored: StoredPendantSessionDocument): Promise<boolean> {
    if (this.fail.create) throw new Error("create failed");
    return this.delegate.create(stored);
  }

  async saveSession(stored: StoredPendantSessionDocument): Promise<void> {
    if (this.fail.saveSession) throw new Error("save failed");
    await this.delegate.saveSession(stored);
  }

  async saveSegment(
    stored: StoredPendantSessionDocument,
    segmentValue: Parameters<PendantSessionRepository["saveSegment"]>[1],
  ): Promise<void> {
    if (this.fail.saveSegment) throw new Error("segment save failed");
    await this.delegate.saveSegment(stored, segmentValue);
  }

  async replaceInsightRefs(
    stored: StoredPendantSessionDocument,
  ): Promise<void> {
    if (this.fail.replaceInsightRefs) throw new Error("refs save failed");
    await this.delegate.replaceInsightRefs(stored);
  }

  async delete(
    params: Parameters<PendantSessionRepository["delete"]>[0],
  ): Promise<void> {
    if (this.fail.delete) throw new Error("delete failed");
    await this.delegate.delete(params);
  }
}

describe("handlePendantSessionRoutes", () => {
  it("reloads the canonical winner after a cross-process create conflict", async () => {
    const ownerId = uuid();
    const agentId = uuid();
    const winner: StoredPendantSessionDocument = {
      schemaVersion: 1,
      session: {
        id: "sess-race",
        ownerId,
        agentId,
        startedAt: "2026-07-17T00:00:00.000Z",
        endedAt: "2026-07-17T00:01:00.000Z",
        state: "ended",
        captureLease: null,
        processingLocation: "cloud",
        revision: 4,
      },
      segments: [],
      insightRefs: [],
    };
    let loads = 0;
    const repository: PendantSessionRepository = {
      load: vi.fn(async () => (++loads === 1 ? null : winner)),
      create: vi.fn(async () => false),
      saveSession: vi.fn(async () => undefined),
      saveSegment: vi.fn(async () => undefined),
      replaceInsightRefs: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
    };
    const h = makeHarness(ownerId, repository, agentId);

    const result = await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-race",
    });
    const body = okBody<{
      snapshot: { session: { state: string; revision: number } };
    }>(result);

    expect(body.snapshot.session).toMatchObject({
      state: "ended",
      revision: 4,
    });
    expect(repository.create).toHaveBeenCalledTimes(1);
    expect(repository.load).toHaveBeenCalledTimes(2);
  });

  it("preserves dispatcher query parameters and its pre-parsed request body", async () => {
    const ownerId = uuid();
    const body = { revision: 7 };
    const req = {
      method: "GET",
      url: "/api/pendant/sessions/sess-query",
      headers: { host: "127.0.0.1" },
      query: { afterRevision: "7", tag: ["one", "two"] },
      body,
    } as unknown as http.IncomingMessage;
    const runtime = {
      getSetting: (key: string) =>
        key === "ELIZA_ADMIN_ENTITY_ID" ? ownerId : null,
    } as never;

    const context = buildPendantSessionRouteContext(
      req,
      {} as http.ServerResponse,
      runtime,
    );

    expect(context.url.searchParams.get("afterRevision")).toBe("7");
    expect(context.url.searchParams.getAll("tag")).toEqual(["one", "two"]);
    expect(context.state.adminEntityId).toBe(ownerId);
    await expect(context.readJsonBody(req, context.res)).resolves.toBe(body);
  });

  it("supports capturer append observed by follower and follower pause observed by capturer", async () => {
    const h = makeHarness();
    const created = okBody<{ snapshot: { session: { id: string } } }>(
      await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-a" }),
    );
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/lease", {
        holder: "capturer",
        leaseMs: 30_000,
      }),
    );

    await h.request("POST", "/api/pendant/sessions/sess-a/segments", {
      leaseToken: lease.leaseToken,
      segment: segment(created.snapshot.session.id, 0),
    });
    const follower = okBody<{
      changed: true;
      snapshot: { segments: unknown[] };
    }>(await h.request("GET", "/api/pendant/sessions/sess-a?afterRevision=0"));
    expect(follower.snapshot.segments).toHaveLength(1);

    const paused = okBody<{
      snapshot: { session: { state: string; revision: number } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/pause", {
        revision: 2,
      }),
    );
    expect(paused.snapshot.session.state).toBe("paused");

    const capturer = okBody<{
      changed: true;
      snapshot: { session: { state: string } };
    }>(await h.request("GET", "/api/pendant/sessions/sess-a?afterRevision=2"));
    expect(capturer.snapshot.session.state).toBe("paused");

    const resumed = okBody<{
      snapshot: { session: { state: string; revision: number } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/resume", {
        revision: paused.snapshot.session.revision,
      }),
    );
    expect(resumed.snapshot.session.state).toBe("active");
  });

  it("notifies post-commit consumers from the canonical durable segment only once", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-hook",
    });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-hook/lease", {
        holder: "capturer",
      }),
    );
    const committed = vi.fn();
    const unsubscribe = subscribePendantCommittedSegments(committed);

    try {
      await h.request("POST", "/api/pendant/sessions/sess-hook/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-hook", 0),
      });
      await h.request("POST", "/api/pendant/sessions/sess-hook/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-hook", 0),
      });
      expect(committed).toHaveBeenCalledTimes(1);
      expect(committed.mock.calls[0]?.[0].segment).toMatchObject({
        id: "sess-hook:segment:0",
        sessionId: "sess-hook",
        ordinal: 0,
        revision: 0,
      });
      const stored = okBody<{
        changed: true;
        snapshot: { segments: unknown[] };
      }>(await h.request("GET", "/api/pendant/sessions/sess-hook"));
      expect(committed.mock.calls[0]?.[0].snapshot.segments).toEqual(
        stored.snapshot.segments,
      );
    } finally {
      unsubscribe();
    }
  });

  it("writes one owner-private canonical Memory with pendant provenance", async () => {
    const ownerId = uuid();
    const h = makeHarness(ownerId);
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-memory",
    });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-memory/lease", {
        holder: "capturer",
      }),
    );

    const mutation = await h.request(
      "POST",
      "/api/pendant/sessions/sess-memory/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-memory", 0, 0, "private pendant fact"),
      },
    );
    expect(mutation.status).toBe(200);
    expect(h.runtime.memories).toHaveLength(1);
    const [memory] = [...h.runtime.memories.values()];
    expect(memory).toMatchObject({
      entityId: ownerId,
      agentId: h.runtime.agentId,
      content: {
        text: "private pendant fact",
        source: "pendant",
        channelType: "VOICE_DM",
      },
      metadata: {
        provider: "pendant",
        scope: "owner-private",
        scopedToEntityId: ownerId,
        base: { source: "pendant", scope: "owner-private" },
        pendant: {
          userId: ownerId,
          sessionId: "sess-memory",
          segmentId: "sess-memory:segment:0",
        },
      },
    });
    expect(h.runtime.createMemory).toHaveBeenCalledWith(
      expect.objectContaining({ id: memory?.id }),
      "messages",
      true,
    );

    await h.request("POST", "/api/pendant/sessions/sess-memory/segments", {
      leaseToken: lease.leaseToken,
      segment: segment("sess-memory", 0, 0, "private pendant fact"),
    });
    expect(h.runtime.memories).toHaveLength(1);
    expect(h.runtime.createMemory).toHaveBeenCalledTimes(1);
  });

  it("keeps exact duplicate replay idempotent and conflicts altered same-revision content", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-b" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-b/lease", {
        holder: "capturer",
      }),
    );
    const first = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = okBody<{
      snapshot: {
        session: { revision: number };
        segments: Array<{ text: string }>;
      };
    }>(first);
    expect(firstBody.snapshot.session.revision).toBe(2);
    const replay = okBody<{
      snapshot: {
        session: { revision: number };
        segments: Array<{ text: string }>;
      };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-b/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0),
      }),
    );
    expect(replay.snapshot.session.revision).toBe(2);
    const alteredReplay = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0, 0, "changed"),
      },
    );
    expect(alteredReplay.status).toBe(409);
    expect(
      (alteredReplay.body as { error?: { code?: string } }).error?.code,
    ).toBe("revision_conflict");
  });

  it("rejects late revisions, client-spoofed segment fields, and out-of-order ordinal", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-b2" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-b2/lease", {
        holder: "capturer",
      }),
    );
    await h.request("POST", "/api/pendant/sessions/sess-b2/segments", {
      leaseToken: lease.leaseToken,
      segment: segment("sess-b2", 0),
    });
    const late = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-b2/segments/sess-b2%3Asegment%3A0",
      {
        leaseToken: lease.leaseToken,
        revision: 3,
        text: "late",
      },
    );
    expect(late.status).toBe(409);
    const malformed = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b2/segments",
      {
        leaseToken: lease.leaseToken,
        segment: {
          ...segment("sess-b2", 1),
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      },
    );
    expect(malformed.status).toBe(400);
    const outOfOrder = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b2/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b2", 2),
      },
    );
    expect(outOfOrder.status).toBe(400);
  });

  it("patches late ASR revisions in place, preserves id/createdAt, and advances updatedAt", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-f" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-f/lease", {
        holder: "capturer",
      }),
    );
    const appended = okBody<{
      snapshot: {
        segments: Array<{
          id: string;
          sessionId: string;
          text: string;
          createdAt: string;
          updatedAt: string;
        }>;
      };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-f/segments", {
        leaseToken: lease.leaseToken,
        segment: { ...segment("sess-f", 0), status: "pending", text: "" },
      }),
    );
    const original = appended.snapshot.segments[0];
    expect(original?.id).toBe("sess-f:segment:0");
    expect(original?.sessionId).toBe("sess-f");
    await new Promise((resolve) => setTimeout(resolve, 2));
    const patched = okBody<{
      snapshot: {
        segments: Array<{
          id: string;
          text: string;
          createdAt: string;
          updatedAt: string;
        }>;
      };
    }>(
      await h.request(
        "PATCH",
        "/api/pendant/sessions/sess-f/segments/sess-f%3Asegment%3A0",
        {
          leaseToken: lease.leaseToken,
          revision: 1,
          status: "resolved",
          text: "resolved words",
          speakerCluster: "speaker-1",
        },
      ),
    );
    expect(patched.snapshot.segments).toHaveLength(1);
    expect(patched.snapshot.segments[0]?.id).toBe(original?.id);
    expect(patched.snapshot.segments[0]?.createdAt).toBe(original?.createdAt);
    expect(patched.snapshot.segments[0]?.updatedAt).not.toBe(
      original?.updatedAt,
    );
    expect(patched.snapshot.segments[0]?.text).toBe("resolved words");

    const patchReplay = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-f/segments/sess-f%3Asegment%3A0",
      {
        leaseToken: lease.leaseToken,
        revision: 1,
        text: "different words",
      },
    );
    expect(patchReplay.status).toBe(409);
  });

  it("makes ended sessions immutable", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-f2" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-f2/lease", {
        holder: "capturer",
      }),
    );
    await h.request("POST", "/api/pendant/sessions/sess-f2/segments", {
      leaseToken: lease.leaseToken,
      segment: { ...segment("sess-f2", 0), status: "pending", text: "" },
    });

    const ended = okBody<{ snapshot: { session: { state: string } } }>(
      await h.request("POST", "/api/pendant/sessions/sess-f2/end", {}),
    );
    expect(ended.snapshot.session.state).toBe("ended");
    const blocked = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-f2/segments/sess-f2%3Asegment%3A0",
      {
        leaseToken: lease.leaseToken,
        revision: 1,
        text: "too late",
      },
    );
    expect(blocked.status).toBe(409);
    const exported = okBody<{ export: { segments: Array<{ text: string }> } }>(
      await h.request("GET", "/api/pendant/sessions/sess-f2/export"),
    );
    expect(exported.export.segments[0]?.text).toBe("");
  });

  it("allows lease takeover only after expiry and blocks appends while paused", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-c" });
    const first = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "a",
        leaseMs: 50,
      }),
    );
    const conflict = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/lease",
      {
        holder: "b",
        leaseMs: 30_000,
      },
    );
    expect(conflict.status).toBe(409);
    const renameRenewal = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/lease",
      {
        holder: "b",
        leaseToken: first.leaseToken,
        leaseMs: 30_000,
      },
    );
    expect(renameRenewal.status).toBe(409);
    const renewal = okBody<{
      leaseToken: string;
      session: { captureLease: { holder: string } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "a",
        leaseToken: first.leaseToken,
        leaseMs: 50,
      }),
    );
    expect(renewal.session.captureLease.holder).toBe("a");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "b",
        leaseMs: 30_000,
      }),
    );
    expect(second.leaseToken).not.toBe(first.leaseToken);

    await h.request("POST", "/api/pendant/sessions/sess-c/segments", {
      leaseToken: second.leaseToken,
      segment: {
        ...segment("sess-c", 0),
        status: "pending",
        text: "",
        endedAt: null,
      },
    });
    await h.request("POST", "/api/pendant/sessions/sess-c/pause", {});
    const blocked = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/segments",
      {
        leaseToken: second.leaseToken,
        segment: segment("sess-c", 1),
      },
    );
    expect(blocked.status).toBe(409);
    const lateAsr = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-c/segments/sess-c%3Asegment%3A0",
      {
        leaseToken: second.leaseToken,
        revision: 1,
        status: "resolved",
        text: "must not land after pause",
        endedAt: "2026-07-09T00:00:01.000Z",
      },
    );
    expect(lateAsr.status).toBe(409);
    expect(h.runtime.memories).toHaveLength(0);
  });

  it("converges polling, deletes from memory, and enforces owner and agent isolation", async () => {
    const owner = uuid();
    const h = makeHarness(owner);
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-d" });
    const unchanged = okBody<{ changed: false }>(
      await h.request("GET", "/api/pendant/sessions/sess-d?afterRevision=0"),
    );
    expect(unchanged.changed).toBe(false);

    const isolated = makeHarness(uuid());
    isolated.state.runtime = h.state.runtime;
    const missing = await isolated.request(
      "GET",
      "/api/pendant/sessions/sess-d",
    );
    expect(missing.status).toBe(404);

    const differentAgent = makeHarness(owner, h.repository);
    const agentMissing = await differentAgent.request(
      "GET",
      "/api/pendant/sessions/sess-d",
    );
    expect(agentMissing.status).toBe(404);

    const deleted = await h.request("DELETE", "/api/pendant/sessions/sess-d");
    expect(deleted.status).toBe(200);
    expect(h.broadcastWs).toHaveBeenCalledWith({
      type: "pendant-session:deleted",
      sessionId: "sess-d",
      agentId: h.runtime.agentId,
    });
    const afterDelete = await h.request("GET", "/api/pendant/sessions/sess-d");
    expect(afterDelete.status).toBe(404);
  });

  it("requires authenticated admin identity", async () => {
    const h = makeHarness();
    h.state.adminEntityId = null as never;
    const result = await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-auth",
    });
    expect(result.status).toBe(401);
    expect((result.body as { error?: { code?: string } }).error?.code).toBe(
      "auth",
    );
  });

  it("returns typed validation errors for malformed encoding and invalid afterRevision", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-v" });

    for (const query of ["abc", "1.2", "-1"]) {
      const result = await h.request(
        "GET",
        `/api/pendant/sessions/sess-v?afterRevision=${query}`,
      );
      expect(result.status).toBe(400);
      expect((result.body as { error?: { code?: string } }).error?.code).toBe(
        "validation",
      );
    }

    const malformed = await h.request("GET", "/api/pendant/sessions/%E0%A4%A");
    expect(malformed.status).toBe(400);
    expect((malformed.body as { error?: { code?: string } }).error?.code).toBe(
      "validation",
    );
  });

  it("maps repository create and update failures to typed store_unavailable", async () => {
    const createHarness = makeHarness(
      uuid(),
      new FailingPendantSessionRepository(undefined, { create: true }),
    );
    const createFailed = await createHarness.request(
      "POST",
      "/api/pendant/sessions",
      { sessionId: "sess-store" },
    );
    expect(createFailed.status).toBe(503);
    expect(
      (createFailed.body as { error?: { code?: string } }).error?.code,
    ).toBe("store_unavailable");

    const updateHarness = makeHarness(
      uuid(),
      new FailingPendantSessionRepository(undefined, { saveSession: true }),
    );
    await updateHarness.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-store-update",
    });
    const updateFailed = await updateHarness.request(
      "POST",
      "/api/pendant/sessions/sess-store-update/lease",
      { holder: "capturer" },
    );
    expect(updateFailed.status).toBe(503);
    expect(
      (updateFailed.body as { error?: { code?: string } }).error?.code,
    ).toBe("store_unavailable");
  });

  it("maps repository revision CAS conflicts to typed current-revision responses", async () => {
    const delegate = new InMemoryPendantSessionRepository();
    const repository: PendantSessionRepository = {
      load: (params) => delegate.load(params),
      create: (value) => delegate.create(value),
      saveSession: vi.fn(async () => {
        throw new PendantSessionRevisionConflictError(9);
      }),
      saveSegment: (storedValue, segmentValue) =>
        delegate.saveSegment(storedValue, segmentValue),
      replaceInsightRefs: (value) => delegate.replaceInsightRefs(value),
      delete: (params) => delegate.delete(params),
    };
    const h = makeHarness(uuid(), repository);
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-cas-route",
    });

    const result = await h.request(
      "POST",
      "/api/pendant/sessions/sess-cas-route/lease",
      { holder: "capturer" },
    );

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ok: false,
      error: {
        code: "revision_conflict",
        currentRevision: 9,
      },
    });
  });

  it("exports portable sessions and rejects insight refs for unknown segments", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-e" });
    const badRef = await h.request(
      "PUT",
      "/api/pendant/sessions/sess-e/insight-refs",
      {
        insightRefs: [
          {
            id: "i1",
            segmentIds: ["missing"],
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            revision: 0,
          },
        ],
      },
    );
    expect(badRef.status).toBe(400);
    const exported = okBody<{ export: { session: { id: string } } }>(
      await h.request("GET", "/api/pendant/sessions/sess-e/export"),
    );
    expect(exported.export.session.id).toBe("sess-e");
  });

  it("rejects duplicate insight ref IDs before changing the session revision", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-duplicate-ref",
    });
    const lease = okBody<{ leaseToken: string }>(
      await h.request(
        "POST",
        "/api/pendant/sessions/sess-duplicate-ref/lease",
        {
          holder: "capturer",
        },
      ),
    );
    const before = okBody<{ snapshot: { session: { revision: number } } }>(
      await h.request(
        "POST",
        "/api/pendant/sessions/sess-duplicate-ref/segments",
        {
          leaseToken: lease.leaseToken,
          segment: segment("sess-duplicate-ref", 0),
        },
      ),
    );

    const duplicate = await h.request(
      "PUT",
      "/api/pendant/sessions/sess-duplicate-ref/insight-refs",
      {
        revision: before.snapshot.session.revision,
        insightRefs: [
          {
            id: "insight-dup",
            segmentIds: ["sess-duplicate-ref:segment:0"],
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            revision: 0,
          },
          {
            id: "insight-dup",
            segmentIds: ["sess-duplicate-ref:segment:0"],
            createdAt: "2026-07-09T00:00:01.000Z",
            updatedAt: "2026-07-09T00:00:01.000Z",
            revision: 0,
          },
        ],
      },
    );
    const after = okBody<{ export: { session: { revision: number } } }>(
      await h.request("GET", "/api/pendant/sessions/sess-duplicate-ref/export"),
    );

    expect(duplicate.status).toBe(400);
    expect((duplicate.body as { error?: { code?: string } }).error?.code).toBe(
      "validation",
    );
    expect(after.export.session.revision).toBe(
      before.snapshot.session.revision,
    );
  });
});
