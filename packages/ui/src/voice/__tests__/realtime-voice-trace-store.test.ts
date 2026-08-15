/** Exercises bounded, content-free browser persistence for realtime traces. */

import {
  createRealtimeVoiceTrace,
  finalizeRealtimeVoiceTrace,
  inspectRealtimeVoiceTraceCoverage,
  markRealtimeVoiceTrace,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { shellLocalStorage } from "../../surface-realm-channel";
import {
  type CompletedNormalVoiceTrace,
  createNormalVoiceTraceCollector,
} from "../realtime-voice-trace-collector";
import {
  clearPersistedNormalVoiceTraces,
  NORMAL_VOICE_TRACE_STORAGE_KEY,
  NORMAL_VOICE_TRACE_STORAGE_LIMIT,
  persistCompletedNormalVoiceTrace,
  persistCompletedNormalVoiceTraceDetailed,
  readPersistedNormalVoiceTraces,
  serializePersistedNormalVoiceTraces,
} from "../realtime-voice-trace-store";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function completed(turnId: string, offset = 0): CompletedNormalVoiceTrace {
  let trace = createRealtimeVoiceTrace({
    sessionId: "session-1",
    turnId,
    responseId: turnId,
    atMs: offset,
    profiles: ["transcription"],
  });
  trace = markRealtimeVoiceTrace(trace, "acoustic_speech_ended", offset + 5);
  trace = markRealtimeVoiceTrace(trace, "stt_final", offset + 10);
  trace = finalizeRealtimeVoiceTrace(trace, "no_response", offset + 20);
  return {
    trace,
    coverage: inspectRealtimeVoiceTraceCoverage(trace),
  };
}

describe("normal realtime voice trace store", () => {
  it("uses the privileged shell channel for the reserved browser key", () => {
    const storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage });
    const writer = vi.spyOn(shellLocalStorage, "setItem");
    try {
      expect(persistCompletedNormalVoiceTrace(completed("browser-turn"))).toBe(
        true,
      );
      expect(writer).toHaveBeenCalledWith(
        NORMAL_VOICE_TRACE_STORAGE_KEY,
        expect.any(String),
      );
    } finally {
      writer.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("round-trips validated traces and recomputes coverage", () => {
    const storage = memoryStorage();
    expect(persistCompletedNormalVoiceTrace(completed("turn-1"), storage)).toBe(
      true,
    );
    expect(readPersistedNormalVoiceTraces(storage)).toEqual([
      expect.objectContaining({
        trace: expect.objectContaining({ turnId: "turn-1" }),
        coverage: expect.objectContaining({ complete: true, finalized: true }),
      }),
    ]);
  });

  it("deduplicates retries and keeps only the newest bounded cohort", () => {
    const storage = memoryStorage();
    persistCompletedNormalVoiceTrace(completed("same", 0), storage);
    persistCompletedNormalVoiceTrace(completed("same", 100), storage);
    for (let index = 0; index <= NORMAL_VOICE_TRACE_STORAGE_LIMIT; index += 1) {
      persistCompletedNormalVoiceTrace(
        completed(`turn-${index}`, 200 + index * 30),
        storage,
      );
    }
    const traces = readPersistedNormalVoiceTraces(storage);
    expect(traces).toHaveLength(NORMAL_VOICE_TRACE_STORAGE_LIMIT);
    expect(traces[0]?.trace.turnId).toBe("turn-1");
    expect(traces.at(-1)?.trace.turnId).toBe(
      `turn-${NORMAL_VOICE_TRACE_STORAGE_LIMIT}`,
    );
  });

  it("fails closed on corrupt data and storage errors", () => {
    const storage = memoryStorage();
    storage.setItem(NORMAL_VOICE_TRACE_STORAGE_KEY, "not-json");
    expect(readPersistedNormalVoiceTraces(storage)).toEqual([]);
    expect(
      persistCompletedNormalVoiceTrace(completed("turn-1"), {
        ...storage,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).toBe(false);
    expect(() => clearPersistedNormalVoiceTraces(storage)).not.toThrow();
    expect(storage.getItem(NORMAL_VOICE_TRACE_STORAGE_KEY)).toBeNull();
  });

  it("reports only a bounded content-free persistence failure reason", () => {
    expect(
      persistCompletedNormalVoiceTraceDetailed(completed("turn-1"), null),
    ).toEqual({ saved: false, failure: "storage_unavailable" });
    expect(
      persistCompletedNormalVoiceTraceDetailed(completed("turn-1"), {
        ...memoryStorage(),
        setItem: () => {
          throw new Error("secret-shaped implementation detail");
        },
      }),
    ).toEqual({ saved: false, failure: "storage_write_failed" });
  });

  it("persists an incomplete error trace without weakening schema validation", () => {
    const storage = memoryStorage();
    const collector = createNormalVoiceTraceCollector((result) => {
      expect(persistCompletedNormalVoiceTraceDetailed(result, storage)).toEqual(
        { saved: true, failure: null },
      );
    });
    collector.resetSession("session-error");
    collector.accept({ name: "stt_final", traceId: "turn-error", atMs: 10 });
    collector.accept({
      name: "llm_requested",
      traceId: "turn-error",
      atMs: 11,
    });
    collector.accept({
      name: "turn_end(error)",
      traceId: "turn-error",
      atMs: 12,
    });

    expect(readPersistedNormalVoiceTraces(storage)).toHaveLength(1);
  });

  it("exports only validated content-free traces in a deterministic envelope", () => {
    const storage = memoryStorage();
    persistCompletedNormalVoiceTrace(completed("turn-export"), storage);
    const artifact = JSON.parse(
      serializePersistedNormalVoiceTraces(storage),
    ) as Record<string, unknown>;

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      source: "normal-chat-realtime-voice",
      traceCount: 1,
      traces: [expect.objectContaining({ turnId: "turn-export" })],
    });
    const keys = new Set<string>();
    JSON.stringify(artifact, (key, value) => {
      if (key) keys.add(key);
      return value;
    });
    expect(keys).not.toContain("text");
    expect(keys).not.toContain("transcriptText");
    expect(keys).not.toContain("audioBytes");
    expect(keys).not.toContain("apiKey");
    expect(serializePersistedNormalVoiceTraces(storage)).toBe(
      serializePersistedNormalVoiceTraces(storage),
    );
  });
});
