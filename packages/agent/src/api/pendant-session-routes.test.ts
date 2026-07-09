/**
 * Route-level tests for pendant session sync using the real in-memory adapter.
 *
 * The runtime wrapper is intentionally narrow, but storage operations go through
 * InMemoryDatabaseAdapter rather than a fake map so create/update/delete memory
 * behavior matches the repository persistence contract.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../core/src/database/inMemoryAdapter.ts";
import type { Memory } from "../../../core/src/types/memory.ts";
import type { UUID } from "../../../core/src/types/primitives.ts";

vi.mock("@elizaos/core", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
  MemoryType: { CUSTOM: "custom" },
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

const { handlePendantSessionRoutes, subscribePendantCommittedSegments } =
  await import("./pendant-session-routes");

class TestRuntime {
  readonly agentId: UUID;
  readonly adapter: InMemoryDatabaseAdapter;
  createMemoryThrows = false;
  updateMemorySucceeds = true;

  constructor(agentId: UUID, adapter = new InMemoryDatabaseAdapter()) {
    this.agentId = agentId;
    this.adapter = adapter;
    void this.adapter.init();
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    const memories = await this.adapter.getMemoriesByIds([id]);
    return memories[0] ?? null;
  }

  async createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ): Promise<UUID> {
    if (this.createMemoryThrows) throw new Error("create failed");
    const ids = await this.adapter.createMemories([
      { memory, tableName, unique },
    ]);
    const id = ids[0];
    if (!id) throw new Error("adapter did not return memory id");
    return id;
  }

  async updateMemory(memory: Partial<Memory> & { id: UUID }): Promise<boolean> {
    if (!this.updateMemorySucceeds) return false;
    await this.adapter.updateMemories([memory]);
    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.adapter.deleteMemories([memoryId]);
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
  adapter?: InMemoryDatabaseAdapter,
  agentId = uuid(),
) {
  const runtime = new TestRuntime(agentId, adapter);
  const broadcastWs = vi.fn();
  const state = {
    runtime: runtime as never,
    adminEntityId: ownerId,
    broadcastWs,
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

  return { request, runtime, state, broadcastWs };
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

describe("handlePendantSessionRoutes", () => {
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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T00:00:00.000Z"));
    const h = makeHarness();
    try {
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
      vi.setSystemTime(new Date("2026-07-09T00:00:01.000Z"));
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
    } finally {
      vi.useRealTimers();
    }
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

    await h.request("POST", "/api/pendant/sessions/sess-c/pause", {});
    const blocked = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/segments",
      {
        leaseToken: second.leaseToken,
        segment: segment("sess-c", 0),
      },
    );
    expect(blocked.status).toBe(409);
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

    const differentAgent = makeHarness(owner, h.runtime.adapter);
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

  it("maps storage create and update failures to typed store_unavailable", async () => {
    const createHarness = makeHarness();
    createHarness.runtime.createMemoryThrows = true;
    const createFailed = await createHarness.request(
      "POST",
      "/api/pendant/sessions",
      { sessionId: "sess-store" },
    );
    expect(createFailed.status).toBe(503);
    expect(
      (createFailed.body as { error?: { code?: string } }).error?.code,
    ).toBe("store_unavailable");

    const updateHarness = makeHarness();
    await updateHarness.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-store-update",
    });
    updateHarness.runtime.updateMemorySucceeds = false;
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
});
