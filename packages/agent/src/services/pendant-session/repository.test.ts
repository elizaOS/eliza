import type { PendantSegment } from "@elizaos/shared/contracts/pendant-session-sync";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  InMemoryPendantSessionRepository,
  SqlPendantSessionRepository,
  type StoredPendantSessionDocument,
} from "./repository.ts";
import {
  pendantSessionInsightRefs,
  pendantSessionSegments,
  pendantSessions,
} from "./schema.ts";

function stored(): StoredPendantSessionDocument {
  return {
    schemaVersion: 1,
    session: {
      id: "session-1",
      ownerId: "owner-1",
      agentId: "agent-1",
      startedAt: "2026-07-17T00:00:00.000Z",
      endedAt: null,
      state: "active",
      captureLease: null,
      processingLocation: "cloud",
      revision: 0,
    },
    segments: [],
    insightRefs: [],
  };
}

function storedWithRevision(revision: number): StoredPendantSessionDocument {
  const value = stored();
  value.session.revision = revision;
  return value;
}

function segment(): PendantSegment {
  return {
    id: "session-1:segment:0",
    sessionId: "session-1",
    ordinal: 0,
    status: "resolved",
    text: "hello",
    words: [{ word: "hello", startMs: 0, endMs: 100 }],
    speakerCluster: null,
    speakerAlias: null,
    confidence: 0.9,
    error: null,
    startedAt: "2026-07-17T00:00:00.000Z",
    endedAt: "2026-07-17T00:00:01.000Z",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    revision: 0,
  };
}

function queryText(query?: {
  queryChunks: Array<{ value?: unknown }>;
}): string {
  expect(query).toBeDefined();
  if (!query) return "";
  return query.queryChunks
    .flatMap((chunk) =>
      Array.isArray(chunk.value) ? chunk.value : [chunk.value],
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
}

describe("pendant session relational persistence", () => {
  it("registers normalized tables with composite keys and cascading children", () => {
    const session = getTableConfig(pendantSessions);
    const segments = getTableConfig(pendantSessionSegments);
    const insightRefs = getTableConfig(pendantSessionInsightRefs);

    expect(session.name).toBe("pendant_sessions");
    expect(session.primaryKeys).toHaveLength(1);
    expect(segments.name).toBe("pendant_session_segments");
    expect(segments.primaryKeys).toHaveLength(1);
    expect(segments.foreignKeys).toHaveLength(1);
    expect(insightRefs.name).toBe("pendant_session_insight_refs");
    expect(insightRefs.primaryKeys).toHaveLength(1);
    expect(insightRefs.foreignKeys).toHaveLength(1);
  });

  it("creates sessions atomically instead of load-then-upsert", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-1" }] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(repository.create(stored())).resolves.toBe(true);
    await expect(repository.create(stored())).resolves.toBe(false);

    for (const [query] of execute.mock.calls) {
      const text = queryText(query);
      expect(text).toContain("INSERT INTO app_lifeops.pendant_sessions");
      expect(text).toContain("ON CONFLICT (owner_id, agent_id, id) DO NOTHING");
      expect(text).toContain("RETURNING id");
      expect(text).not.toContain("SELECT");
    }
  });

  it("discovers only the newest active session inside the owner and agent boundary", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(
      repository.loadLatest({ ownerId: "owner-1", agentId: "agent-1" }),
    ).resolves.toBeNull();

    expect(execute).toHaveBeenCalledTimes(1);
    const text = queryText(execute.mock.calls[0]?.[0]);
    expect(text).toContain("WHERE owner_id = 'owner-1'");
    expect(text).toContain("AND agent_id = 'agent-1'");
    expect(text).toContain("AND state <> 'ended'");
    expect(text).toContain("ORDER BY started_at DESC, id DESC");
    expect(text).toContain("LIMIT 1");
  });

  it("compares revisions in the session update and returns the current revision on CAS conflict", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ revision: 7 }] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(repository.saveSession(storedWithRevision(2))).rejects.toEqual(
      expect.objectContaining({
        currentRevision: 7,
        name: "PendantSessionRevisionConflictError",
      }),
    );

    const updateText = queryText(execute.mock.calls[0]?.[0]);
    expect(updateText).toContain("UPDATE app_lifeops.pendant_sessions");
    expect(updateText).toContain("AND revision = 1");
    expect(updateText).toContain("RETURNING revision");
  });

  it("writes a session revision and segment in one runtime database transaction", async () => {
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ revision: 1 }] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const transaction = vi.fn(async (work: (db: typeof tx) => Promise<void>) =>
      work(tx),
    );
    const execute = vi.fn();
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute, transaction } },
    });

    await repository.saveSegment(storedWithRevision(1), segment());

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(2);
    expect(queryText(tx.execute.mock.calls[0]?.[0])).toContain(
      "UPDATE app_lifeops.pendant_sessions",
    );
    expect(queryText(tx.execute.mock.calls[1]?.[0])).toContain(
      "INSERT INTO app_lifeops.pendant_session_segments",
    );
  });

  it("lets the runtime transaction roll back session CAS when the child segment write fails", async () => {
    const childFailure = new Error("segment insert failed");
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ revision: 1 }] })
        .mockRejectedValueOnce(childFailure),
    };
    let rolledBack = false;
    const transaction = vi.fn(
      async (work: (db: typeof tx) => Promise<void>) => {
        try {
          await work(tx);
        } catch (err) {
          rolledBack = true;
          throw err;
        }
      },
    );
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute: vi.fn(), transaction } },
    });

    await expect(
      repository.saveSegment(storedWithRevision(1), segment()),
    ).rejects.toThrow(childFailure.message);

    expect(rolledBack).toBe(true);
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("replaces insight refs in the same transaction as the session revision", async () => {
    const value = storedWithRevision(1);
    value.insightRefs = [
      {
        id: "insight-1",
        segmentIds: ["session-1:segment:0"],
        createdAt: "2026-07-17T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
        revision: 0,
      },
    ];
    const tx = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ rows: [{ revision: 1 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const transaction = vi.fn(async (work: (db: typeof tx) => Promise<void>) =>
      work(tx),
    );
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute: vi.fn(), transaction } },
    });

    await repository.replaceInsightRefs(value);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.execute).toHaveBeenCalledTimes(3);
    expect(queryText(tx.execute.mock.calls[0]?.[0])).toContain(
      "UPDATE app_lifeops.pendant_sessions",
    );
    expect(queryText(tx.execute.mock.calls[1]?.[0])).toContain(
      "DELETE FROM app_lifeops.pendant_session_insight_refs",
    );
    expect(queryText(tx.execute.mock.calls[2]?.[0])).toContain(
      "INSERT INTO app_lifeops.pendant_session_insight_refs",
    );
  });
});

describe("InMemoryPendantSessionRepository", () => {
  it("sorts saved segments deterministically with safe NaN handling", async () => {
    const repo = new InMemoryPendantSessionRepository();
    const doc = stored();
    await repo.create(doc);

    const seg1: PendantSegment = {
      ...segment(),
      id: "seg-1",
      ordinal: 2,
    };
    const seg0: PendantSegment = {
      ...segment(),
      id: "seg-0",
      ordinal: 0,
    };
    const segNaN: PendantSegment = {
      ...segment(),
      id: "seg-nan",
      ordinal: NaN as unknown as number,
    };

    let current = await repo.load({
      ownerId: "owner-1",
      agentId: "agent-1",
      sessionId: "session-1",
    });
    if (!current) throw new Error("session not found");
    await repo.saveSegment(current, seg1);

    current = await repo.load({
      ownerId: "owner-1",
      agentId: "agent-1",
      sessionId: "session-1",
    });
    if (!current) throw new Error("session not found");
    await repo.saveSegment(current, seg0);

    current = await repo.load({
      ownerId: "owner-1",
      agentId: "agent-1",
      sessionId: "session-1",
    });
    if (!current) throw new Error("session not found");
    await repo.saveSegment(current, segNaN);

    const fetched = await repo.load({
      ownerId: "owner-1",
      agentId: "agent-1",
      sessionId: "session-1",
    });
    expect(fetched).not.toBeNull();
    expect(fetched?.segments.length).toBe(3);
    expect(fetched?.segments.map((s) => s.id)).toEqual([
      "seg-0",
      "seg-nan",
      "seg-1",
    ]);
  });
});
