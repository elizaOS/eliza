/**
 * Exercises grounded generation plus real derived-memory lifecycle semantics with
 * an in-memory runtime double, including revisions, tenant isolation, and delete.
 */

import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Memory, UUID } from "@elizaos/core";
import { makeSourceSegment } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  cascadeDeletePendantInsightsForSession,
  formatPendantInsightsMemory,
  generatePendantInsights,
  handlePendantInsightsRoutes,
  type PendantInsightsIdentity,
  type PendantInsightsMemoryRuntime,
  pendantInsightsMemoryId,
  persistPendantInsights,
} from "./pendant-insights-routes.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const identity: PendantInsightsIdentity = {
  ownerId: "00000000-0000-0000-0000-000000000002",
  agentId: AGENT_ID,
  sessionId: "test-session",
};
const segments = [0, 1, 2].map((ordinal) =>
  makeSourceSegment({
    sessionId: identity.sessionId,
    ordinal,
    text: `segment ${ordinal}`,
    atMs: 100 + ordinal,
  }),
);

function memoryRuntime() {
  const memories = new Map<UUID, Memory>();
  const createMemory = vi.fn(async (memory: Memory) => {
    if (!memory.id) throw new Error("memory id required");
    memories.set(memory.id, memory);
    return memory.id;
  });
  const updateMemory = vi.fn(async (patch: Partial<Memory> & { id: UUID }) => {
    const existing = memories.get(patch.id);
    if (!existing) throw new Error("memory missing");
    memories.set(patch.id, { ...existing, ...patch });
    return true;
  });
  const deleteMemory = vi.fn(async (id: UUID) => {
    memories.delete(id);
  });
  const runtime: PendantInsightsMemoryRuntime = {
    agentId: AGENT_ID,
    getMemoryById: vi.fn(async (id: UUID) => memories.get(id) ?? null),
    createMemory,
    updateMemory,
    deleteMemory,
    redactSecrets: vi.fn((text: string) =>
      text.replace(/API_KEY=\w+/g, "[REDACTED]"),
    ),
  };
  return { runtime, memories, createMemory, updateMemory, deleteMemory };
}

async function generatedRollup() {
  const generated = await generatePendantInsights({
    segments,
    now: () => 999,
    runModel: async () =>
      JSON.stringify({
        summary: "Discussed shipping the reference surface.",
        actionItems: [
          {
            text: "Follow up with Shadow",
            owner: "Sol",
            dueAt: "2026-07-10",
            confidence: 0.95,
            sourceSegmentIds: [segments[0].id],
          },
        ],
      }),
  });
  if (!generated.ok) throw new Error("expected generated rollup");
  return generated;
}

describe("generatePendantInsights", () => {
  it("stamps trusted fields, exact included provenance, and removes ungrounded items", async () => {
    const runModel = vi.fn(async () =>
      JSON.stringify({
        summary: "A short meeting.",
        actionItems: [
          {
            text: "Follow up",
            confidence: 0.9,
            sourceSegmentIds: [segments[1].id],
          },
        ],
        topics: [
          { label: "invented", salience: 0.7, sourceSegmentIds: ["ghost"] },
        ],
      }),
    );
    const result = await generatePendantInsights({
      segments,
      runModel,
      now: () => 999,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.insights.generatedAt).toBe(999);
    expect(result.insights.transcriptRange).toEqual({
      startOrdinal: 0,
      endOrdinal: 2,
      segmentCount: 3,
      startedAtMs: 100,
      endedAtMs: 102,
    });
    expect(result.insights.actionItems).toHaveLength(1);
    expect(result.insights.topics).toEqual([]);
    expect(result.sourceSegments).toEqual(
      segments.map((segment) => ({
        id: segment.id,
        ordinal: segment.ordinal,
        revision: 0,
      })),
    );
  });

  it("skips below threshold without calling the model", async () => {
    const runModel = vi.fn(async () => "{}");
    const result = await generatePendantInsights({
      segments: segments.slice(0, 2),
      runModel,
    });
    expect(result).toEqual({ ok: false, skip: "too-few-segments" });
    expect(runModel).not.toHaveBeenCalled();
  });

  it("fails closed on malformed model output", async () => {
    const result = await generatePendantInsights({
      segments,
      runModel: async () => "not json",
    });
    expect(result.ok).toBe(false);
    if (!result.ok && "error" in result) {
      expect(result.error).toMatch(/no JSON object/);
    }
  });

  it("passes cancellation to the model and drops a late result", async () => {
    const controller = new AbortController();
    let seenSignal: AbortSignal | undefined;
    const result = await generatePendantInsights({
      segments,
      signal: controller.signal,
      runModel: async (_prompt, signal) => {
        seenSignal = signal;
        controller.abort("disconnect");
        return "{}";
      },
    });
    expect(seenSignal).toBe(controller.signal);
    expect(result).toEqual({ ok: false, skip: "cancelled" });
  });
});

describe("pendant insight route cancellation", () => {
  it("cancels an active model call before a session cascade delete", async () => {
    const { runtime } = memoryRuntime();
    const req = Object.assign(new EventEmitter(), { aborted: false });
    const res = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
    });
    let modelStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      modelStarted = resolve;
    });
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(
        async (_modelType: unknown, params: { signal?: AbortSignal }) => {
          modelStarted();
          return new Promise<string>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted")),
              { once: true },
            );
          });
        },
      ),
    };
    const json = vi.fn();
    const routePromise = handlePendantInsightsRoutes({
      req: req as unknown as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      method: "POST",
      pathname: "/api/pendant/insights",
      state: {
        runtime: runtimeWithModel,
        adminEntityId: identity.ownerId as UUID,
      },
      json,
      error: vi.fn(),
      readJsonBody: vi.fn(async () => ({
        enabled: true,
        sessionId: identity.sessionId,
        segments,
      })),
    });
    await started;
    const cascade = await cascadeDeletePendantInsightsForSession({
      runtime,
      identity,
    });
    expect(cascade).toEqual({ cancelled: 1, deleted: false });
    await expect(routePromise).resolves.toBe(true);
    expect(json).toHaveBeenCalledWith(res, {
      ok: false,
      reason: "cancelled",
    });
  });
});

describe("pendant insights agent memory integration", () => {
  it("creates then updates one tenant-scoped same-agent memory across revisions", async () => {
    const generated = await generatedRollup();
    const { runtime, memories, createMemory, updateMemory } = memoryRuntime();
    const firstId = await persistPendantInsights({
      runtime,
      identity,
      insights: generated.insights,
      sourceSegments: generated.sourceSegments,
      generationStartedAt: 100,
    });
    const revisedSources = generated.sourceSegments.map((source, index) => ({
      ...source,
      revision: index === 0 ? 1 : source.revision,
    }));
    const secondId = await persistPendantInsights({
      runtime,
      identity,
      insights: {
        ...generated.insights,
        summary: "Rotated API_KEY=supersecretvalue123",
        generatedAt: 1_000,
      },
      sourceSegments: revisedSources,
      generationStartedAt: 200,
    });
    await persistPendantInsights({
      runtime,
      identity,
      insights: {
        ...generated.insights,
        summary: "stale slower result",
        generatedAt: 2_000,
      },
      sourceSegments: revisedSources,
      generationStartedAt: 150,
    });

    expect(firstId).toBe(pendantInsightsMemoryId(identity));
    expect(secondId).toBe(firstId);
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(updateMemory).toHaveBeenCalledTimes(1);
    const stored = memories.get(firstId as UUID);
    expect(stored?.content.text).not.toContain("stale slower result");
    expect(stored?.content.text).not.toContain("supersecretvalue123");
    expect(stored?.content.text).toContain("[REDACTED]");
    expect(stored).toEqual(
      expect.objectContaining({
        id: firstId,
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: runtime.agentId,
        unique: true,
        content: expect.objectContaining({ source: "pendant-insights" }),
        metadata: expect.objectContaining({
          source: "pendant-insights",
          scope: "owner-private",
          ownerId: identity.ownerId,
          agentId: identity.agentId,
          sessionId: identity.sessionId,
          sourceSegments: revisedSources,
        }),
      }),
    );
    expect(formatPendantInsightsMemory(generated.insights)).toContain(
      "Follow up with Shadow (owner: Sol, due: 2026-07-10",
    );
  });

  it("does not persist an empty quiet-window rollup", async () => {
    const { runtime, createMemory, updateMemory } = memoryRuntime();
    const id = await persistPendantInsights({
      runtime,
      identity,
      insights: {
        schemaVersion: 1,
        summary: "",
        actionItems: [],
        topics: [],
        peopleMentioned: [],
        notableQuotes: [],
        generatedAt: 1,
        transcriptRange: {
          startOrdinal: 0,
          endOrdinal: 2,
          segmentCount: 3,
          startedAtMs: 0,
          endedAtMs: 0,
        },
      },
      sourceSegments: segments.map((segment) => ({
        id: segment.id,
        ordinal: segment.ordinal,
        revision: 0,
      })),
    });
    expect(id).toBeNull();
    expect(createMemory).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("cascade-deletes only exact owner/agent/session provenance", async () => {
    const generated = await generatedRollup();
    const { runtime, memories, deleteMemory } = memoryRuntime();
    await persistPendantInsights({
      runtime,
      identity,
      insights: generated.insights,
      sourceSegments: generated.sourceSegments,
    });
    const mismatchedIdentity = { ...identity, ownerId: "owner-b" };
    const forgedId = pendantInsightsMemoryId(mismatchedIdentity);
    const original = memories.get(pendantInsightsMemoryId(identity));
    if (!original) throw new Error("expected original memory");
    memories.set(forgedId, {
      ...original,
      id: forgedId,
      metadata: { ...original.metadata, ownerId: identity.ownerId },
    });

    await expect(
      cascadeDeletePendantInsightsForSession({
        runtime,
        identity: mismatchedIdentity,
      }),
    ).rejects.toThrow(/outside its tenant session/);
    expect(deleteMemory).not.toHaveBeenCalled();

    const result = await cascadeDeletePendantInsightsForSession({
      runtime,
      identity,
    });
    expect(result).toEqual({ cancelled: 0, deleted: true });
    expect(memories.has(pendantInsightsMemoryId(identity))).toBe(false);
  });
});
