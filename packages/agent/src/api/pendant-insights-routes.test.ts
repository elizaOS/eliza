import type { Memory, UUID } from "@elizaos/core";
import { makeSourceSegment } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  formatPendantInsightsMemory,
  generatePendantInsights,
  persistPendantInsights,
} from "./pendant-insights-routes.ts";

const segments = [0, 1, 2].map((ordinal) =>
  makeSourceSegment({
    sessionId: "test-session",
    ordinal,
    text: `segment ${ordinal}`,
    atMs: 100 + ordinal,
  }),
);

describe("generatePendantInsights", () => {
  it("generates, stamps trusted fields, and removes ungrounded items", async () => {
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
  });

  it("skips below the server threshold without calling the model", async () => {
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
    expect(result).toEqual({ ok: false, error: "cancelled" });
  });
});

describe("pendant insights agent memory integration", () => {
  it("persists structured insights into the same agent memory with a deterministic id", async () => {
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
    expect(generated.ok).toBe(true);
    if (!generated.ok) return;

    let stored: Memory | null = null;
    const createMemory = vi.fn(async (memory: Memory) => {
      stored = memory;
      return memory.id as UUID;
    });
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001" as UUID,
      getMemoryById: vi.fn(async (id: UUID) =>
        stored?.id === id ? stored : null,
      ),
      createMemory,
    };
    const firstId = await persistPendantInsights({
      runtime,
      insights: generated.insights,
      segmentIds: segments.map((segment) => segment.id),
    });
    const secondId = await persistPendantInsights({
      runtime,
      insights: generated.insights,
      segmentIds: segments.map((segment) => segment.id),
    });

    expect(firstId).toBe(secondId);
    expect(createMemory).toHaveBeenCalledTimes(1);
    expect(createMemory).toHaveBeenCalledWith(
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
          insights: generated.insights,
        }),
      }),
      "messages",
      true,
    );
    expect(formatPendantInsightsMemory(generated.insights)).toContain(
      "Follow up with Shadow (owner: Sol, due: 2026-07-10",
    );
  });

  it("does not pollute memory with an empty quiet-window rollup", async () => {
    const createMemory = vi.fn();
    const id = await persistPendantInsights({
      runtime: {
        agentId: "00000000-0000-0000-0000-000000000001" as UUID,
        getMemoryById: vi.fn(async () => null),
        createMemory,
      },
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
      segmentIds: segments.map((segment) => segment.id),
    });
    expect(id).toBeNull();
    expect(createMemory).not.toHaveBeenCalled();
  });
});
