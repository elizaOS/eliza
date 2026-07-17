import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
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

function queryText(query: { queryChunks: Array<{ value?: unknown }> }): string {
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
});
