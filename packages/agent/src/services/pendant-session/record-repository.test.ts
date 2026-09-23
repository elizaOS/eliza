/** Exercises native pendant persistence with real SQLite files, concurrent revisions and restart recovery. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import type { PendantSegment } from "@elizaos/shared/contracts/pendant-session-sync";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPendantSessionRepository,
  PendantSessionRevisionConflictError,
  type StoredPendantSessionDocument,
} from "./repository.ts";

const agentId = randomUUID() as UUID;
const time = "2026-09-23T12:00:00.000Z";
let directory: string;
const opened: SQLiteDatabaseAdapter[] = [];
async function open() {
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  opened.push(adapter);
  await adapter.initialize();
  return {
    adapter,
    repository: createPendantSessionRepository({ agentId, adapter }),
  };
}
function document(): StoredPendantSessionDocument {
  return {
    schemaVersion: 1,
    session: {
      id: "capture",
      ownerId: "owner",
      agentId,
      startedAt: time,
      endedAt: null,
      state: "active",
      captureLease: {
        holder: "device",
        expiresAt: "2026-09-23T13:00:00.000Z",
        tokenDigest: "synthetic-digest",
      },
      processingLocation: "cloud",
      revision: 0,
    },
    segments: [],
    insightRefs: [],
  };
}
function scope(stored: StoredPendantSessionDocument) {
  return {
    ownerId: stored.session.ownerId,
    agentId: stored.session.agentId,
    sessionId: stored.session.id,
  };
}
function segment(ordinal: number): PendantSegment {
  return {
    id: `segment-${ordinal}`,
    sessionId: "capture",
    ordinal,
    status: "resolved",
    text: "complete synthetic transcript ".repeat(2000),
    words: [{ word: "complete", startMs: 0, endMs: 100 }],
    speakerCluster: null,
    speakerAlias: null,
    confidence: 0.9,
    error: null,
    startedAt: time,
    endedAt: time,
    createdAt: time,
    updatedAt: time,
    revision: 0,
  };
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pendant-sqlite-"));
});
afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  await rm(directory, { recursive: true, force: true });
});

it("retains complete leases, transcripts and ordered insights after close/reopen", async () => {
  const { adapter, repository } = await open();
  const stored = document();
  expect(await repository.create(stored)).toBe(true);
  for (const ordinal of [1, 0]) {
    stored.session.revision++;
    await repository.saveSegment(stored, segment(ordinal));
  }
  stored.session.revision++;
  stored.insightRefs = [
    {
      id: "insight",
      segmentIds: ["segment-0", "segment-1"],
      revision: 0,
      createdAt: time,
      updatedAt: time,
    },
  ];
  await repository.replaceInsightRefs(stored);
  const before = await repository.load(scope(stored));
  expect(before).toEqual({ ...stored, segments: [segment(0), segment(1)] });
  await adapter.close();
  const reopened = await open();
  expect(await reopened.repository.load(scope(stored))).toEqual(before);
  expect(await reopened.repository.loadLatest(scope(stored))).toEqual(before);
  stored.session.revision++;
  stored.session.state = "ended";
  stored.session.endedAt = time;
  await reopened.repository.saveSession(stored);
  expect(await reopened.repository.loadLatest(scope(stored))).toBeNull();
  expect((await reopened.repository.load(scope(stored)))?.segments).toEqual([
    segment(0),
    segment(1),
  ]);
});

it("allows one concurrent creator and preserves the HTTP revision-conflict type for stale mutations", async () => {
  const { repository } = await open();
  const stored = document();
  expect(
    (
      await Promise.all([repository.create(stored), repository.create(stored)])
    ).sort(),
  ).toEqual([false, true]);
  stored.session.revision = 1;
  const results = await Promise.allSettled([
    repository.saveSession(stored),
    repository.saveSession(stored),
  ]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  if (!rejected) throw new Error("Expected a stale revision rejection");
  expect(rejected.reason).toBeInstanceOf(PendantSessionRevisionConflictError);
  expect(rejected.reason.currentRevision).toBe(1);
  expect((await repository.load(scope(stored)))?.session.revision).toBe(1);
});

it("rolls back revisions on duplicate ordinals and on an enclosing transaction failure", async () => {
  const { adapter, repository } = await open();
  const stored = document();
  await repository.create(stored);
  stored.session.revision = 1;
  await repository.saveSegment(stored, segment(0));
  const before = await repository.load(scope(stored));
  stored.session.revision = 2;
  await expect(
    repository.saveSegment(stored, { ...segment(0), id: "duplicate" }),
  ).rejects.toMatchObject({ code: "PENDANT_RECORD_INVALID" });
  expect(await repository.load(scope(stored))).toEqual(before);
  await expect(
    adapter.recordStore.transaction(async () => {
      await repository.saveSegment(stored, segment(1));
      throw new Error("synthetic rollback");
    }),
  ).rejects.toMatchObject({ code: "SQLITE_TRANSACTION_FAILED" });
  expect(await repository.load(scope(stored))).toEqual(before);
});

it("keeps owners isolated, rejects another agent, and deletes only the selected session", async () => {
  const { adapter, repository } = await open();
  const stored = document();
  const other = document();
  other.session.ownerId = "other-owner";
  await repository.create(stored);
  await repository.create(other);
  expect(
    await repository.load({ ...scope(stored), ownerId: "unknown" }),
  ).toBeNull();
  await expect(
    repository.load({ ...scope(stored), agentId: randomUUID() }),
  ).rejects.toMatchObject({ code: "PENDANT_RECORD_INVALID" });
  expect(() =>
    createPendantSessionRepository({ agentId: randomUUID(), adapter }),
  ).toThrow(/agent-bound/);
  await repository.delete(scope(stored));
  expect(await repository.load(scope(stored))).toBeNull();
  expect(await repository.load(scope(other))).toEqual(other);
});

it("rejects corrupt records and unknown schema versions without returning fabricated emptiness", async () => {
  const { adapter, repository } = await open();
  const stored = document();
  await repository.create(stored);
  await adapter.recordStore.set(
    "plugin_eliza_pendant_sessions_v1",
    JSON.stringify(["owner", agentId, "capture"]),
    { ...stored, schemaVersion: 2 },
  );
  await expect(repository.load(scope(stored))).rejects.toMatchObject({
    code: "PENDANT_RECORD_INVALID",
  });
  await adapter.recordStore.set(
    "plugin_eliza_pendant_sessions_schema",
    "version",
    2,
  );
  await expect(repository.loadLatest(scope(stored))).rejects.toMatchObject({
    code: "PENDANT_RECORD_INVALID",
  });
});
