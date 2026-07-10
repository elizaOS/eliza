/**
 * Exercises grounded generation plus real derived-memory lifecycle semantics with
 * an in-memory runtime double, including revisions, tenant isolation, and delete.
 */

import { EventEmitter } from "node:events";
import type http from "node:http";
import type { Memory, UUID } from "@elizaos/core";
import { makeSourceSegment } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { syntheticAmbientDay } from "./__fixtures__/ambient-insights-day.ts";
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

function ambientSegments(sessionId: string, count: number) {
  return Array.from({ length: count }, (_, ordinal) => ({
    ...makeSourceSegment({
      sessionId,
      ordinal,
      text: `ambient segment ${ordinal}`,
      atMs: 1_000 + ordinal,
    }),
    status: "finalized" as const,
  }));
}

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

async function postInsightsRoute(args: {
  runtime: PendantInsightsMemoryRuntime & {
    useModel: (
      modelType: unknown,
      params: { prompt: string; signal?: AbortSignal },
    ) => Promise<unknown>;
  };
  ownerId?: UUID;
  body: Record<string, unknown>;
}) {
  const req = Object.assign(new EventEmitter(), { aborted: false });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  });
  let payload: unknown;
  const json = vi.fn((_res: http.ServerResponse, data: unknown) => {
    payload = data;
  });
  const error = vi.fn();
  const handled = await handlePendantInsightsRoutes({
    req: req as unknown as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    method: "POST",
    pathname: "/api/pendant/insights",
    state: {
      runtime: args.runtime,
      adminEntityId: args.ownerId ?? (identity.ownerId as UUID),
    },
    json,
    error,
    readJsonBody: vi.fn(async () => args.body),
  });
  expect(handled).toBe(true);
  return { payload, json, error };
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

describe("ambient pendant insights quality gates", () => {
  it("rolls only newly finalized canonical segments plus bounded finalized context", async () => {
    const sessionId = "ambient-window";
    const baseIdentity = { ...identity, sessionId };
    const { runtime } = memoryRuntime();
    const prompts: string[] = [];
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(
        async (_modelType: unknown, params: { prompt: string }) => {
          prompts.push(params.prompt);
          const sourceSegmentIds = Array.from(
            params.prompt.matchAll(/\[(ambient-window:segment:\d+)\]/g),
            (match) => match[1],
          );
          return JSON.stringify({
            summary: "Grounded ambient rollup.",
            summarySourceSegmentIds: sourceSegmentIds.slice(-1),
            actionItems: [
              {
                text: "Buy milk",
                owner: null,
                confidence: 0.9,
                sourceSegmentIds: sourceSegmentIds.slice(-1),
              },
            ],
          });
        },
      ),
    };

    await postInsightsRoute({
      runtime: runtimeWithModel,
      body: {
        enabled: true,
        mode: "ambient",
        sessionId,
        ambient: {
          minSegments: 3,
          minIntervalMs: 0,
          dailyCallCap: 48,
          contextTailSegments: 2,
        },
        segments: ambientSegments(sessionId, 10),
      },
    });

    const secondSegments = ambientSegments(sessionId, 13).map((segment) =>
      segment.ordinal === 10
        ? {
            ...segment,
            text: "pending should not be visible",
            status: "pending" as const,
          }
        : segment,
    );
    await postInsightsRoute({
      runtime: runtimeWithModel,
      body: {
        enabled: true,
        mode: "ambient",
        sessionId,
        ambient: {
          minSegments: 2,
          minIntervalMs: 0,
          dailyCallCap: 48,
          contextTailSegments: 2,
        },
        segments: secondSegments,
      },
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("[ambient-window:segment:8]");
    expect(prompts[1]).toContain("[ambient-window:segment:9]");
    expect(prompts[1]).toContain("[ambient-window:segment:11]");
    expect(prompts[1]).toContain("[ambient-window:segment:12]");
    expect(prompts[1]).not.toContain("[ambient-window:segment:0]");
    expect(prompts[1]).not.toContain("pending should not be visible");

    await postInsightsRoute({
      runtime: runtimeWithModel,
      body: {
        enabled: true,
        mode: "ambient",
        sessionId,
        ambient: {
          minSegments: 1,
          minIntervalMs: 0,
          dailyCallCap: 48,
          contextTailSegments: 1,
        },
        segments: ambientSegments(sessionId, 13),
      },
    });
    expect(prompts).toHaveLength(3);
    expect(prompts[2]).toContain("[ambient-window:segment:10]");

    const stored = await runtime.getMemoryById(
      pendantInsightsMemoryId(baseIdentity),
    );
    const metadata = stored?.metadata as Record<string, unknown>;
    const insights = metadata.insights as {
      actionItems: Array<{ sourceSegmentIds: string[] }>;
    };
    expect(insights.actionItems).toHaveLength(1);
    expect(insights.actionItems[0].sourceSegmentIds).toEqual(
      expect.arrayContaining([
        "ambient-window:segment:9",
        "ambient-window:segment:12",
      ]),
    );
  });

  it("checkpoints empty ambient windows instead of reprocessing quiet history", async () => {
    const sessionId = "ambient-empty-checkpoint";
    const { runtime } = memoryRuntime();
    const prompts: string[] = [];
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(
        async (_modelType: unknown, params: { prompt: string }) => {
          prompts.push(params.prompt);
          return prompts.length === 1
            ? JSON.stringify({})
            : JSON.stringify({
                summary: "A new task appeared.",
                summarySourceSegmentIds: [`${sessionId}:segment:5`],
              });
        },
      ),
    };
    const request = (count: number) =>
      postInsightsRoute({
        runtime: runtimeWithModel,
        body: {
          enabled: true,
          mode: "ambient",
          sessionId,
          ambient: {
            minSegments: 3,
            minIntervalMs: 0,
            dailyCallCap: 48,
            contextTailSegments: 0,
          },
          segments: ambientSegments(sessionId, count),
        },
      });

    await request(3);
    await request(6);

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain(`${sessionId}:segment:0`);
    expect(prompts[1]).toContain(`${sessionId}:segment:5`);
  });

  it("enforces a server-side ambient daily call cap before the model call", async () => {
    const sessionId = "ambient-budget";
    const { runtime } = memoryRuntime();
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(async () =>
        JSON.stringify({
          summary: "one call",
          summarySourceSegmentIds: [`${sessionId}:segment:2`],
        }),
      ),
    };
    const body = (count: number) => ({
      enabled: true,
      mode: "ambient",
      sessionId,
      ambient: {
        minSegments: 3,
        minIntervalMs: 0,
        dailyCallCap: 1,
        contextTailSegments: 0,
      },
      segments: ambientSegments(sessionId, count),
    });

    const first = await postInsightsRoute({
      runtime: runtimeWithModel,
      body: body(3),
    });
    const second = await postInsightsRoute({
      runtime: runtimeWithModel,
      body: body(6),
    });

    expect(first.payload).toMatchObject({ ok: true });
    expect(second.payload).toEqual({ ok: false, reason: "budget-exhausted" });
    expect(runtimeWithModel.useModel).toHaveBeenCalledTimes(1);
  });

  it("chunks an all-day digest and charges every model call before starting", async () => {
    const sessionId = "ambient-long-digest";
    const { runtime } = memoryRuntime();
    const longDay = ambientSegments(sessionId, 180).map((segment) => ({
      ...segment,
      text: `${segment.text} ${"meeting errands and casual context ".repeat(4)}`,
    }));
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(
        async (_modelType: unknown, params: { prompt: string }) => {
          const ids = Array.from(
            params.prompt.matchAll(/\[(ambient-long-digest:segment:\d+)\]/g),
            (match) => match[1],
          );
          return JSON.stringify({
            summary: "A bounded part of the day.",
            summarySourceSegmentIds: ids.slice(-1),
            digest: {
              summary: "A bounded part of the day.",
              summarySourceSegmentIds: ids.slice(-1),
              actionItems: [
                {
                  text: "Send the notes",
                  owner: null,
                  confidence: 0.9,
                  sourceSegmentIds: ids.slice(-1),
                },
              ],
            },
          });
        },
      ),
    };
    const body = {
      enabled: true,
      mode: "ambient",
      kind: "digest",
      sessionId,
      ambient: {
        minSegments: 8,
        minIntervalMs: 0,
        dailyCallCap: 48,
        contextTailSegments: 0,
      },
      segments: longDay,
    };

    const result = await postInsightsRoute({ runtime: runtimeWithModel, body });

    expect(result.payload).toMatchObject({ ok: true });
    expect(runtimeWithModel.useModel.mock.calls.length).toBeGreaterThan(1);
    const digest = (
      result.payload as {
        insights: {
          digest: {
            actionItems: Array<{ sourceSegmentIds: string[] }>;
          };
        };
      }
    ).insights.digest;
    expect(digest.actionItems).toHaveLength(1);
    expect(digest.actionItems[0].sourceSegmentIds).toHaveLength(
      runtimeWithModel.useModel.mock.calls.length,
    );

    const cappedSession = "ambient-long-capped";
    const cappedRuntime = memoryRuntime().runtime;
    const cappedModel = {
      ...cappedRuntime,
      useModel: vi.fn(async () => "{}"),
    };
    const capped = await postInsightsRoute({
      runtime: cappedModel,
      body: {
        ...body,
        sessionId: cappedSession,
        ambient: { ...body.ambient, dailyCallCap: 1 },
        segments: longDay.map((segment) => ({
          ...segment,
          sessionId: cappedSession,
          id: `${cappedSession}:segment:${segment.ordinal}`,
        })),
      },
    });
    expect(capped.payload).toEqual({ ok: false, reason: "budget-exhausted" });
    expect(cappedModel.useModel).not.toHaveBeenCalled();
  });

  it("derives digest identity from trusted user-local timezone config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T02:00:00.000Z"));
    try {
      const sessionId = "ambient-local-day";
      const { runtime } = memoryRuntime();
      runtime.getSetting = (key: string) =>
        key === "TIMEZONE" ? "America/Denver" : undefined;
      const runtimeWithModel = {
        ...runtime,
        useModel: vi.fn(async () => "{}"),
      };
      const result = await postInsightsRoute({
        runtime: runtimeWithModel,
        body: {
          enabled: true,
          mode: "ambient",
          kind: "digest",
          sessionId,
          segments: [],
        },
      });
      expect(result.payload).toMatchObject({
        ok: true,
        insights: { dayKey: "2026-07-09" },
      });
      expect(runtimeWithModel.useModel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("writes exactly one digest per ambient session-day and permits an empty day", async () => {
    const sessionId = "ambient-empty-digest";
    const { runtime } = memoryRuntime();
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(async () => {
        throw new Error("empty digest should not call model");
      }),
    };
    const body = {
      enabled: true,
      mode: "ambient",
      kind: "digest",
      sessionId,
      ambient: {
        minSegments: 8,
        minIntervalMs: 0,
        dailyCallCap: 48,
        contextTailSegments: 0,
      },
      segments: [],
    };

    const first = await postInsightsRoute({ runtime: runtimeWithModel, body });
    const second = await postInsightsRoute({ runtime: runtimeWithModel, body });

    expect(first.payload).toMatchObject({
      ok: true,
      insights: {
        kind: "digest",
        summary: "",
        digest: {
          summary: "",
          actionItems: [],
          commitments: [],
          followUps: [],
          notableMoments: [],
        },
      },
      provenance: { sourceSegments: [] },
    });
    expect(second.payload).toEqual({
      ok: false,
      reason: "digest-already-generated",
    });
    expect(runtimeWithModel.useModel).not.toHaveBeenCalled();
  });

  it("grounds digest citations to real canonical ids and removes invented ids", async () => {
    const sessionId = "ambient-digest";
    const { runtime } = memoryRuntime();
    const runtimeWithModel = {
      ...runtime,
      useModel: vi.fn(async () =>
        JSON.stringify({
          summary: "The day mixed errands and a design sync.",
          summarySourceSegmentIds: [`${sessionId}:segment:0`, "ghost"],
          actionItems: [
            {
              text: "Pick up the prescription",
              owner: null,
              confidence: 0.95,
              sourceSegmentIds: [`${sessionId}:segment:1`, "ghost"],
            },
          ],
          digest: {
            summary: "The day mixed errands and a design sync.",
            summarySourceSegmentIds: [`${sessionId}:segment:0`, "ghost"],
            actionItems: [
              {
                text: "Pick up the prescription",
                owner: null,
                confidence: 0.95,
                sourceSegmentIds: [`${sessionId}:segment:1`, "ghost"],
              },
            ],
            commitments: [
              {
                text: "Send the meeting notes",
                owner: "anonymous",
                confidence: 0.9,
                sourceSegmentIds: [`${sessionId}:segment:2`],
              },
            ],
            followUps: [
              {
                text: "Check whether Sam got the link",
                owner: null,
                confidence: 0.8,
                sourceSegmentIds: [`${sessionId}:segment:3`],
              },
            ],
            notableMoments: [
              {
                text: "A casual lunch chat turned into a reminder.",
                sourceSegmentIds: [`${sessionId}:segment:4`, "ghost"],
              },
            ],
          },
        }),
      ),
    };

    const result = await postInsightsRoute({
      runtime: runtimeWithModel,
      body: {
        enabled: true,
        mode: "ambient",
        kind: "digest",
        sessionId,
        ambient: {
          minSegments: 8,
          minIntervalMs: 0,
          dailyCallCap: 48,
          contextTailSegments: 0,
        },
        segments: syntheticAmbientDay(sessionId),
      },
    });

    expect(result.payload).toMatchObject({ ok: true });
    const payload = result.payload as {
      insights: {
        summarySourceSegmentIds: string[];
        digest: {
          summarySourceSegmentIds: string[];
          actionItems: Array<{ sourceSegmentIds: string[] }>;
          commitments: Array<{ sourceSegmentIds: string[] }>;
          followUps: Array<{ sourceSegmentIds: string[] }>;
          notableMoments: Array<{ sourceSegmentIds: string[] }>;
        };
      };
    };
    const allIds = [
      ...payload.insights.summarySourceSegmentIds,
      ...payload.insights.digest.summarySourceSegmentIds,
      ...payload.insights.digest.actionItems.flatMap(
        (item) => item.sourceSegmentIds,
      ),
      ...payload.insights.digest.commitments.flatMap(
        (item) => item.sourceSegmentIds,
      ),
      ...payload.insights.digest.followUps.flatMap(
        (item) => item.sourceSegmentIds,
      ),
      ...payload.insights.digest.notableMoments.flatMap(
        (item) => item.sourceSegmentIds,
      ),
    ];
    expect(allIds).not.toContain("ghost");
    expect(allIds.every((id) => id.startsWith(`${sessionId}:segment:`))).toBe(
      true,
    );
    const digestPrompt = (
      runtimeWithModel.useModel.mock.calls[0]?.[1] as {
        prompt: string;
      }
    ).prompt;
    expect(digestPrompt).toContain("ship the onboarding copy");
    expect(digestPrompt).toContain("pick up the prescription");
    expect(digestPrompt).toContain("movie and what to cook");
    expect(digestPrompt).not.toContain("interim words");
    expect(digestPrompt).not.toContain("eager hypothesis");
  });
});
