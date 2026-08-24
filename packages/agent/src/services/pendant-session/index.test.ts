/**
 * Barrel-contract tests for the pendant session service module.
 *
 * Real-repository harness: the exported factory and both repository classes
 * run against deterministic in-process driver doubles — no Postgres, no
 * service mocks standing in for the system under test.
 */

import type {
  PendantInsightRef,
  PendantSegment,
} from "@elizaos/shared/contracts/pendant-session-sync";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  createPendantSessionRepository,
  InMemoryPendantSessionRepository,
  pendantSessionSchema,
  SqlPendantSessionRepository,
  type StoredPendantSessionDocument,
} from "./index.ts";
import * as barrelSource from "./repository.ts";

const TS = "2026-08-24T00:00:00.000Z";
const SCOPE = {
  ownerId: "owner-a",
  agentId: "agent-b",
  sessionId: "session-x",
};

type DriverQuery = { queryChunks: Array<{ value?: unknown }> };

function storedDocument(overrides?: {
  sessionId?: string;
  startedAt?: string;
  state?: "active" | "paused" | "ended";
  revision?: number;
}): StoredPendantSessionDocument {
  return {
    schemaVersion: 1,
    session: {
      id: overrides?.sessionId ?? SCOPE.sessionId,
      ownerId: SCOPE.ownerId,
      agentId: SCOPE.agentId,
      startedAt: overrides?.startedAt ?? TS,
      endedAt: null,
      state: overrides?.state ?? "active",
      captureLease: null,
      processingLocation: "cloud",
      revision: overrides?.revision ?? 0,
    },
    segments: [],
    insightRefs: [],
  };
}

function segment(id: string, ordinal: number, text = "hello"): PendantSegment {
  return {
    id,
    sessionId: SCOPE.sessionId,
    ordinal,
    status: "resolved",
    text,
    words: [{ word: "hello", startMs: 0, endMs: 100 }],
    speakerCluster: null,
    speakerAlias: null,
    confidence: 0.9,
    error: null,
    startedAt: TS,
    endedAt: TS,
    createdAt: TS,
    updatedAt: TS,
    revision: 0,
  };
}

function insightRef(id: string, segmentIds: string[]): PendantInsightRef {
  return { id, segmentIds, createdAt: TS, updatedAt: TS, revision: 0 };
}

function driverSessionRow(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: SCOPE.sessionId,
    owner_id: SCOPE.ownerId,
    agent_id: SCOPE.agentId,
    started_at: TS,
    ended_at: null,
    state: "active",
    processing_location: "cloud",
    revision: 1,
    created_at: TS,
    updated_at: TS,
    ...overrides,
  };
}

function queryText(query?: DriverQuery): string {
  if (!query) return "";
  return query.queryChunks
    .flatMap((chunk) =>
      Array.isArray(chunk.value) ? chunk.value : [chunk.value],
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
}

describe("pendant-session service barrel", () => {
  it("re-exports one runtime repository surface and the three-table schema", () => {
    expect(createPendantSessionRepository).toBe(
      barrelSource.createPendantSessionRepository,
    );
    expect(InMemoryPendantSessionRepository).toBe(
      barrelSource.InMemoryPendantSessionRepository,
    );
    expect(SqlPendantSessionRepository).toBe(
      barrelSource.SqlPendantSessionRepository,
    );
    expect(typeof createPendantSessionRepository).toBe("function");
    expect(Object.keys(pendantSessionSchema)).toEqual([
      "pendantSessions",
      "pendantSessionSegments",
      "pendantSessionInsightRefs",
    ]);
    expect(getTableConfig(pendantSessionSchema.pendantSessions).name).toBe(
      "pendant_sessions",
    );
    expect(
      getTableConfig(pendantSessionSchema.pendantSessionSegments).name,
    ).toBe("pendant_session_segments");
    expect(
      getTableConfig(pendantSessionSchema.pendantSessionInsightRefs).name,
    ).toBe("pendant_session_insight_refs");
  });

  it("builds a working SQL repository from a runtime database adapter", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: SCOPE.sessionId }] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = createPendantSessionRepository({
      adapter: { db: { execute } },
    });

    expect(repository).toBeInstanceOf(SqlPendantSessionRepository);
    await expect(repository.create(storedDocument())).resolves.toBe(true);
    await expect(repository.create(storedDocument())).resolves.toBe(false);
  });

  it("fails closed on every call when the runtime database adapter is missing", async () => {
    const repository = createPendantSessionRepository({ adapter: {} });

    await expect(repository.load(SCOPE)).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(repository.create(storedDocument())).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(repository.saveSession(storedDocument())).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(repository.delete(SCOPE)).rejects.toThrow(
      "runtime database adapter unavailable",
    );
    await expect(
      repository.replaceInsightRefs(storedDocument()),
    ).rejects.toThrow("runtime database transaction adapter unavailable");
    await expect(
      repository.saveSegment(storedDocument(), segment("seg-0", 0)),
    ).rejects.toThrow("runtime database transaction adapter unavailable");
  });

  it("normalizes driver rows into a complete document across both result shapes", async () => {
    const sessionRow = {
      id: SCOPE.sessionId,
      owner_id: SCOPE.ownerId,
      agent_id: SCOPE.agentId,
      started_at: TS,
      ended_at: null,
      state: "paused",
      processing_location: "cloud",
      revision: "3",
      capture_lease_holder: "device-1",
      capture_lease_expires_at: TS,
      capture_lease_token_digest: "digest-1",
      created_at: TS,
      updated_at: TS,
    };
    const segmentRows = [
      null,
      {
        id: "seg-2",
        session_id: SCOPE.sessionId,
        owner_id: SCOPE.ownerId,
        agent_id: SCOPE.agentId,
        ordinal: "2",
        status: "resolved",
        text: "second",
        words_json: JSON.stringify([{ word: "hi", startMs: 0, endMs: 40 }]),
        speaker_cluster: null,
        speaker_alias: null,
        confidence: null,
        error: null,
        started_at: TS,
        ended_at: null,
        revision: "0",
        created_at: TS,
        updated_at: TS,
      },
      {
        id: "seg-5",
        session_id: SCOPE.sessionId,
        owner_id: SCOPE.ownerId,
        agent_id: SCOPE.agentId,
        ordinal: "5",
        status: "asr-error",
        text: "",
        words_json: "",
        speaker_cluster: "cluster-1",
        speaker_alias: null,
        confidence: "0.5",
        error: "asr failed",
        started_at: TS,
        ended_at: TS,
        revision: "2",
        created_at: TS,
        updated_at: TS,
      },
    ];
    const insightRows = {
      rows: [
        null,
        {
          id: "ref-1",
          session_id: SCOPE.sessionId,
          owner_id: SCOPE.ownerId,
          agent_id: SCOPE.agentId,
          segment_ids_json: JSON.stringify(["seg-2"]),
          revision: "1",
          created_at: TS,
          updated_at: TS,
        },
      ],
    };

    const execute = vi.fn(async (query: DriverQuery) => {
      const text = queryText(query);
      if (text.includes("pendant_session_segments")) return segmentRows;
      if (text.includes("pendant_session_insight_refs")) return insightRows;
      return { rows: [sessionRow] };
    });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    const loaded = await repository.load(SCOPE);

    expect(loaded?.schemaVersion).toBe(1);
    expect(loaded?.session).toEqual({
      id: SCOPE.sessionId,
      ownerId: SCOPE.ownerId,
      agentId: SCOPE.agentId,
      startedAt: TS,
      endedAt: null,
      state: "paused",
      captureLease: {
        holder: "device-1",
        expiresAt: TS,
        tokenDigest: "digest-1",
      },
      processingLocation: "cloud",
      revision: 3,
    });
    expect(
      loaded?.segments.map((s) => ({
        id: s.id,
        ordinal: s.ordinal,
        words: s.words,
        confidence: s.confidence,
        error: s.error,
      })),
    ).toEqual([
      {
        id: "seg-2",
        ordinal: 2,
        words: [{ word: "hi", startMs: 0, endMs: 40 }],
        confidence: null,
        error: null,
      },
      {
        id: "seg-5",
        ordinal: 5,
        words: [],
        confidence: 0.5,
        error: "asr failed",
      },
    ]);
    expect(loaded?.insightRefs).toEqual([
      {
        id: "ref-1",
        segmentIds: ["seg-2"],
        createdAt: TS,
        updatedAt: TS,
        revision: 1,
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("leaves the capture lease unset unless every lease column is present", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: SCOPE.sessionId,
            owner_id: SCOPE.ownerId,
            agent_id: SCOPE.agentId,
            started_at: TS,
            ended_at: "2026-08-24T01:00:00.000Z",
            state: "active",
            processing_location: "on-device",
            revision: 1,
            capture_lease_holder: "device-1",
          },
        ],
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    const loaded = await repository.load(SCOPE);

    expect(loaded?.session.captureLease).toBeNull();
    expect(loaded?.session.endedAt).toBe("2026-08-24T01:00:00.000Z");
    expect(loaded?.session.processingLocation).toBe("on-device");
  });

  it("rejects non-array segment word JSON instead of coercing it", async () => {
    const execute = vi.fn(async (query: DriverQuery) => {
      const text = queryText(query);
      if (text.includes("pendant_session_segments")) {
        return [
          {
            id: "seg-bad",
            session_id: SCOPE.sessionId,
            owner_id: SCOPE.ownerId,
            agent_id: SCOPE.agentId,
            ordinal: 0,
            status: "resolved",
            text: "broken words",
            words_json: '{"word":"hi"}',
            speaker_cluster: null,
            speaker_alias: null,
            confidence: null,
            error: null,
            started_at: TS,
            ended_at: null,
            revision: 0,
            created_at: TS,
            updated_at: TS,
          },
        ];
      }
      if (text.includes("pendant_session_insight_refs")) return [];
      return { rows: [driverSessionRow()] };
    });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(repository.load(SCOPE)).rejects.toThrow(
      "[PendantSessionRepository] Expected JSON array",
    );
  });

  it("rejects unknown session states coming from the driver", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: SCOPE.sessionId,
            owner_id: SCOPE.ownerId,
            agent_id: SCOPE.agentId,
            started_at: TS,
            ended_at: null,
            state: "hijacked",
            processing_location: "cloud",
            revision: 1,
          },
        ],
      })
      .mockResolvedValue([])
      .mockResolvedValue([]);
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(repository.load(SCOPE)).rejects.toThrow();
  });

  it("reports a vanished session row instead of inventing success", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });
    const stored = storedDocument();
    stored.session.revision = 1;

    await expect(repository.saveSession(stored)).rejects.toThrow(
      "pendant session row disappeared during revision update",
    );
  });

  it("refuses a revision update when no prior revision exists", async () => {
    const execute = vi.fn();
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(repository.saveSession(storedDocument())).rejects.toThrow(
      "session revision update requires a prior revision",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("deletes insight refs and segments before the session row", async () => {
    const queries: string[] = [];
    const execute = vi.fn(async (query: DriverQuery) => {
      queries.push(queryText(query));
      return [];
    });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await repository.delete(SCOPE);

    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain(
      "DELETE FROM app_lifeops.pendant_session_insight_refs",
    );
    expect(queries[0]).toContain(`owner_id = '${SCOPE.ownerId}'`);
    expect(queries[0]).toContain(`agent_id = '${SCOPE.agentId}'`);
    expect(queries[0]).toContain(`session_id = '${SCOPE.sessionId}'`);
    expect(queries[1]).toContain(
      "DELETE FROM app_lifeops.pendant_session_segments",
    );
    expect(queries[1]).toContain(`owner_id = '${SCOPE.ownerId}'`);
    expect(queries[1]).toContain(`agent_id = '${SCOPE.agentId}'`);
    expect(queries[1]).toContain(`session_id = '${SCOPE.sessionId}'`);
    expect(queries[2]).toContain("DELETE FROM app_lifeops.pendant_sessions");
    expect(queries[2]).toContain(`owner_id = '${SCOPE.ownerId}'`);
    expect(queries[2]).toContain(`agent_id = '${SCOPE.agentId}'`);
    expect(queries[2]).toContain(`id = '${SCOPE.sessionId}'`);
  });

  it("quotes scope values so embedded quotes stay inside the literal", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });
    const stored = storedDocument();
    stored.session.ownerId = "owner'a";

    await repository.create(stored);

    const text = queryText(execute.mock.calls[0]?.[0]);
    expect(text).toContain("'owner''a'");
    expect(text).not.toContain("'owner'a'");
  });

  it("ignores a blank latest-session id reported by the driver", async () => {
    const execute = vi.fn().mockResolvedValueOnce({ rows: [{ id: "   " }] });
    const repository = new SqlPendantSessionRepository({
      adapter: { db: { execute } },
    });

    await expect(
      repository.loadLatest({ ownerId: SCOPE.ownerId, agentId: SCOPE.agentId }),
    ).resolves.toBeNull();
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

describe("InMemoryPendantSessionRepository", () => {
  it("returns documents only inside the owner, agent, and session scope", async () => {
    const repo = new InMemoryPendantSessionRepository();
    await repo.create(storedDocument());

    expect(await repo.load(SCOPE)).not.toBeNull();
    expect(await repo.load({ ...SCOPE, ownerId: "other" })).toBeNull();
    expect(await repo.load({ ...SCOPE, agentId: "other" })).toBeNull();
    expect(await repo.load({ ...SCOPE, sessionId: "other" })).toBeNull();
  });

  it("keeps the first document when a duplicate key is created", async () => {
    const repo = new InMemoryPendantSessionRepository();
    await expect(repo.create(storedDocument())).resolves.toBe(true);
    const second = storedDocument();
    second.session.startedAt = "2026-08-24T09:00:00.000Z";
    second.session.state = "ended";

    await expect(repo.create(second)).resolves.toBe(false);

    const loaded = await repo.load(SCOPE);
    expect(loaded?.session.startedAt).toBe(TS);
    expect(loaded?.session.state).toBe("active");
  });

  it("hands callers detached copies so store data cannot be mutated", async () => {
    const repo = new InMemoryPendantSessionRepository();
    const doc = storedDocument();
    doc.session.captureLease = {
      holder: "device-1",
      expiresAt: TS,
      tokenDigest: "digest-1",
    };
    doc.segments = [segment("seg-2", 2)];
    doc.insightRefs = [insightRef("ref-1", ["seg-2"])];
    await repo.create(doc);

    const leased = await repo.load(SCOPE);
    if (
      !leased?.session.captureLease ||
      !leased.segments[0] ||
      !leased.insightRefs[0]
    ) {
      throw new Error("expected a fully populated stored document");
    }
    leased.session.state = "ended";
    leased.session.captureLease.holder = "attacker";
    leased.segments[0].text = "mutated";
    leased.segments[0].words.push({ word: "extra", startMs: 100, endMs: 200 });
    leased.insightRefs[0].segmentIds.push("seg-9");

    const reloaded = await repo.load(SCOPE);
    expect(reloaded?.session.state).toBe("active");
    expect(reloaded?.session.captureLease).toEqual({
      holder: "device-1",
      expiresAt: TS,
      tokenDigest: "digest-1",
    });
    expect(reloaded?.segments[0]?.text).toBe("hello");
    expect(reloaded?.segments[0]?.words).toEqual([
      { word: "hello", startMs: 0, endMs: 100 },
    ]);
    expect(reloaded?.insightRefs[0]?.segmentIds).toEqual(["seg-2"]);
  });

  it("loads the newest active session per scope and breaks equal starts deterministically", async () => {
    const repo = new InMemoryPendantSessionRepository();
    await repo.create(
      storedDocument({
        sessionId: "session-old",
        startedAt: "2026-08-24T01:00:00.000Z",
      }),
    );
    await repo.create(
      storedDocument({
        sessionId: "session-tied-low",
        startedAt: "2026-08-24T02:00:00.000Z",
      }),
    );
    await repo.create(
      storedDocument({
        sessionId: "session-tied-high",
        startedAt: "2026-08-24T02:00:00.000Z",
      }),
    );
    await repo.create(
      storedDocument({
        sessionId: "session-ended-newest",
        startedAt: "2026-08-24T03:00:00.000Z",
        state: "ended",
      }),
    );
    const otherAgent = storedDocument({
      sessionId: "session-other-agent",
      startedAt: "2026-08-24T04:00:00.000Z",
    });
    otherAgent.session.agentId = "agent-z";
    await repo.create(otherAgent);

    const latest = await repo.loadLatest({
      ownerId: SCOPE.ownerId,
      agentId: SCOPE.agentId,
    });
    expect(latest?.session.id).toBe("session-tied-low");
    expect(latest?.session.startedAt).toBe("2026-08-24T02:00:00.000Z");

    const forOtherAgent = await repo.loadLatest({
      ownerId: SCOPE.ownerId,
      agentId: "agent-z",
    });
    expect(forOtherAgent?.session.id).toBe("session-other-agent");

    await expect(
      repo.loadLatest({ ownerId: "nobody", agentId: SCOPE.agentId }),
    ).resolves.toBeNull();
  });

  it("updates session fields while preserving stored children", async () => {
    const repo = new InMemoryPendantSessionRepository();
    const doc = storedDocument();
    doc.segments = [segment("seg-2", 2)];
    doc.insightRefs = [insightRef("ref-1", ["seg-2"])];
    await repo.create(doc);

    const updated = storedDocument();
    updated.session.revision = 4;
    updated.session.state = "paused";
    await repo.saveSession(updated);

    const loaded = await repo.load(SCOPE);
    expect(loaded?.session.revision).toBe(4);
    expect(loaded?.session.state).toBe("paused");
    expect(loaded?.segments.map((s) => s.id)).toEqual(["seg-2"]);
    expect(loaded?.insightRefs.map((r) => r.id)).toEqual(["ref-1"]);

    await repo.saveSession(
      storedDocument({ sessionId: "session-fresh", revision: 1 }),
    );
    const createdLate = await repo.load({
      ...SCOPE,
      sessionId: "session-fresh",
    });
    expect(createdLate?.session.revision).toBe(1);
    expect(createdLate?.segments).toEqual([]);
    expect(createdLate?.insightRefs).toEqual([]);
  });

  it("replaces the whole insight-ref list including clearing it", async () => {
    const repo = new InMemoryPendantSessionRepository();
    const doc = storedDocument();
    doc.segments = [segment("seg-2", 2), segment("seg-3", 3)];
    await repo.create(doc);

    const withRefs = storedDocument();
    withRefs.segments = [...doc.segments];
    withRefs.insightRefs = [
      insightRef("ref-1", ["seg-2"]),
      insightRef("ref-2", ["seg-3", "seg-2"]),
    ];
    await repo.replaceInsightRefs(withRefs);

    let loaded = await repo.load(SCOPE);
    expect(loaded?.insightRefs.map((r) => r.id)).toEqual(["ref-1", "ref-2"]);

    await repo.replaceInsightRefs({ ...withRefs, insightRefs: [] });
    loaded = await repo.load(SCOPE);
    expect(loaded?.insightRefs).toEqual([]);
    expect(loaded?.segments).toHaveLength(2);
  });

  it("replaces an existing segment in place instead of duplicating it", async () => {
    const repo = new InMemoryPendantSessionRepository();
    await repo.create(storedDocument());

    let current = await repo.load(SCOPE);
    if (!current) throw new Error("expected stored document");
    await repo.saveSegment(current, segment("seg-b", 2));

    current = await repo.load(SCOPE);
    if (!current) throw new Error("expected stored document");
    await repo.saveSegment(current, segment("seg-a", 1));

    current = await repo.load(SCOPE);
    if (!current) throw new Error("expected stored document");
    await repo.saveSegment(current, segment("seg-b", 2, "rewritten"));

    const loaded = await repo.load(SCOPE);
    expect(loaded?.segments.map((s) => ({ id: s.id, text: s.text }))).toEqual([
      { id: "seg-a", text: "hello" },
      { id: "seg-b", text: "rewritten" },
    ]);
  });

  it("deletes once and tolerates repeated deletes", async () => {
    const repo = new InMemoryPendantSessionRepository();
    await repo.create(storedDocument());

    await repo.delete(SCOPE);
    expect(await repo.load(SCOPE)).toBeNull();

    await expect(repo.delete(SCOPE)).resolves.toBeUndefined();
    await expect(
      repo.delete({ ...SCOPE, sessionId: "never-existed" }),
    ).resolves.toBeUndefined();
  });
});
