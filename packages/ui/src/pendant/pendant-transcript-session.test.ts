/**
 * Pendant transcript session reducer and local-storage persistence coverage.
 */

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isShellReservedStorageKey } from "../surface-realm-broker";
import {
  createLocalOptimisticPendantTranscriptSessionAdapter,
  EMPTY_PENDANT_TRANSCRIPT_SESSION,
  loadPendantTranscriptSession,
  MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS,
  PENDANT_TRANSCRIPT_STORAGE_KEY,
  type PendantTranscriptSegment,
  type PendantTranscriptSessionState,
  parsePendantTranscriptSession,
  pendantTranscriptSessionReducer,
  savePendantTranscriptSession,
} from "./pendant-transcript-session";

class MemoryStorage
  implements Pick<Storage, "getItem" | "setItem" | "removeItem">
{
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class ThrowingSetStorage extends MemoryStorage {
  constructor(private readonly errorName: string) {
    super();
  }

  override setItem(_key: string, _value: string): void {
    throw new DOMException("storage unavailable", this.errorName);
  }
}

class ThrowingGetStorage extends MemoryStorage {
  constructor(private readonly errorName: string) {
    super();
  }

  override getItem(_key: string): string | null {
    throw new DOMException("storage unavailable", this.errorName);
  }
}

function segment(id: number): PendantTranscriptSegment {
  return {
    id: `seg-${id}`,
    status: "resolved",
    text: `segment ${id}`,
    startedAt: id,
    endedAt: id + 1,
    durationMs: 1,
    words: [],
    warning: null,
  };
}

function sessionWithSegments(count: number): PendantTranscriptSessionState {
  return {
    segments: Array.from({ length: count }, (_, index) => segment(index)),
    updatedAt: count,
    clearedThrough: null,
  };
}

describe("pendantTranscriptSessionReducer", () => {
  it("patches one segment from pending to resolved with local word timings", () => {
    const pending = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "segment",
        detail: {
          id: "seg-1",
          status: "pending",
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
        },
      },
    );

    const resolved = pendantTranscriptSessionReducer(pending, {
      type: "segment",
      detail: {
        id: "seg-1",
        status: "resolved",
        text: "hello world",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
        words: [
          { text: "hello", startMs: 0, endMs: 320 },
          { text: "world", startMs: 420, endMs: 900 },
        ],
      },
    });

    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0]).toMatchObject({
      id: "seg-1",
      status: "resolved",
      text: "hello world",
    });
    expect(resolved.segments[0]?.words).toEqual([
      { text: "hello", startMs: 0, endMs: 320 },
      { text: "world", startMs: 420, endMs: 900 },
    ]);
  });

  it("removes silence-discarded pending segments without visible gravel", () => {
    const pending = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "segment",
        detail: {
          id: "seg-2",
          status: "pending",
          startedAt: 5_000,
          endedAt: 5_500,
          durationMs: 500,
        },
      },
    );
    const state = pendantTranscriptSessionReducer(pending, {
      type: "segment",
      detail: {
        id: "seg-2",
        status: "discarded",
        discardReason: "silence",
        startedAt: 5_000,
        endedAt: 5_500,
        durationMs: 500,
      },
    });

    expect(state.segments).toEqual([]);
  });

  it("records ASR failures as quiet visible failed segments", () => {
    const state = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "segment",
        detail: {
          id: "seg-2",
          status: "failed",
          failureReason: "asr-failed",
          warning: "Could not transcribe this segment.",
          startedAt: 5_000,
          endedAt: 5_500,
          durationMs: 500,
        },
      },
    );

    expect(state.segments[0]).toMatchObject({
      id: "seg-2",
      status: "failed",
      text: "",
      words: [],
      warning: "Could not transcribe this segment.",
    });
  });

  it("suppresses late completions for pending segments cleared before completion", () => {
    const pending = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "segment",
        detail: {
          id: "seg-stale",
          status: "pending",
          startedAt: 1_000,
          endedAt: 2_000,
          durationMs: 1_000,
        },
      },
    );

    const cleared = pendantTranscriptSessionReducer(pending, {
      type: "clear",
      at: 3_000,
    });
    const resolvedAfterClear = pendantTranscriptSessionReducer(cleared, {
      type: "segment",
      detail: {
        id: "seg-stale",
        status: "resolved",
        text: "stale text",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
      },
    });
    const droppedAfterClear = pendantTranscriptSessionReducer(cleared, {
      type: "segment",
      detail: {
        id: "seg-stale",
        status: "failed",
        startedAt: 1_000,
        endedAt: 2_000,
        durationMs: 1_000,
      },
    });

    expect(cleared).toEqual({
      segments: [],
      updatedAt: 3_000,
      clearedThrough: 3_000,
    });
    expect(resolvedAfterClear).toBe(cleared);
    expect(droppedAfterClear).toBe(cleared);
  });

  it("allows genuinely new pending segments after clear", () => {
    const cleared = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "clear",
        at: 3_000,
      },
    );

    const next = pendantTranscriptSessionReducer(cleared, {
      type: "segment",
      detail: {
        id: "seg-new",
        status: "pending",
        startedAt: 3_100,
        endedAt: 3_500,
        durationMs: 400,
      },
    });

    expect(next.segments).toHaveLength(1);
    expect(next.segments[0]).toMatchObject({
      id: "seg-new",
      status: "pending",
    });
    expect(next.clearedThrough).toBe(3_000);
  });
});

describe("pendant transcript session storage", () => {
  it("uses a view-owned key outside the shell-reserved namespace", () => {
    expect(isShellReservedStorageKey(PENDANT_TRANSCRIPT_STORAGE_KEY)).toBe(
      false,
    );
  });

  it("round-trips the session through storage", () => {
    const storage = new MemoryStorage();
    const state = pendantTranscriptSessionReducer(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
      {
        type: "segment",
        detail: {
          id: "seg-3",
          status: "resolved",
          text: "persist me",
          startedAt: 10,
          endedAt: 110,
          durationMs: 100,
          words: [{ text: "persist", startMs: 0, endMs: 80 }],
        },
      },
    );

    savePendantTranscriptSession(state, storage);
    expect(storage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY)).toContain(
      "persist me",
    );
    expect(loadPendantTranscriptSession(storage)).toEqual(state);
  });

  it("exposes localStorage through the local optimistic cache adapter seam", () => {
    const storage = new MemoryStorage();
    const adapter =
      createLocalOptimisticPendantTranscriptSessionAdapter(storage);
    const state = sessionWithSegments(1);

    expect(adapter.kind).toBe("local-optimistic-cache");
    adapter.save(state);
    expect(adapter.load()).toEqual(state);

    const cleared = adapter.clear(42);
    expect(cleared).toEqual({
      segments: [],
      updatedAt: 42,
      clearedThrough: 42,
    });
    expect(adapter.load()).toEqual(EMPTY_PENDANT_TRANSCRIPT_SESSION);
  });

  it("loads older persisted sessions that do not carry clear metadata", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [segment(1)],
        updatedAt: 2,
      }),
    );

    expect(loadPendantTranscriptSession(storage)).toEqual({
      segments: [segment(1)],
      updatedAt: 2,
      clearedThrough: null,
    });
  });

  it("normalizes legacy dropped rows from a wider persisted JSON shape", () => {
    expect(
      parsePendantTranscriptSession({
        segments: [
          {
            id: "legacy-dropped",
            status: "dropped",
            text: "",
            startedAt: 10,
            endedAt: 20,
            durationMs: 10,
            words: [],
            extraLegacyField: { ignored: true },
          },
        ],
        updatedAt: 20,
        clearedThrough: "missing in old rows",
      }),
    ).toEqual({
      segments: [
        {
          id: "legacy-dropped",
          status: "failed",
          text: "",
          startedAt: 10,
          endedAt: 20,
          durationMs: 10,
          words: [],
          warning: "Could not transcribe this segment.",
        },
      ],
      updatedAt: 20,
      clearedThrough: null,
    });
  });

  it("persists only the newest retained segments without truncating the in-memory session", () => {
    const storage = new MemoryStorage();
    const state = sessionWithSegments(
      MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS + 2,
    );

    savePendantTranscriptSession(state, storage);

    expect(state.segments).toHaveLength(
      MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS + 2,
    );
    const persisted = loadPendantTranscriptSession(storage);
    expect(persisted.segments).toHaveLength(
      MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS,
    );
    expect(persisted.segments[0]?.id).toBe("seg-2");
    expect(persisted.segments.at(-1)?.id).toBe(
      `seg-${MAX_PERSISTED_PENDANT_TRANSCRIPT_SEGMENTS + 1}`,
    );
  });

  it.each([
    "QuotaExceededError",
    "SecurityError",
  ])("surfaces a setItem failure with %s", (errorName) => {
    const storage = new ThrowingSetStorage(errorName);
    const state = sessionWithSegments(1);

    expect(() => savePendantTranscriptSession(state, storage)).toThrow(
      "Pendant transcript cache could not be saved.",
    );
    expect(loadPendantTranscriptSession(storage)).toEqual(
      EMPTY_PENDANT_TRANSCRIPT_SESSION,
    );
  });

  it.each([
    "SecurityError",
    "UnknownError",
  ])("surfaces a getItem failure with %s", (errorName) => {
    const storage = new ThrowingGetStorage(errorName);

    expect(() => loadPendantTranscriptSession(storage)).toThrow(
      "Pendant transcript cache could not be read.",
    );
  });

  it("surfaces a blocked window.localStorage getter", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage blocked", "SecurityError");
      },
    });

    try {
      expect(() => loadPendantTranscriptSession()).toThrow(
        "Pendant transcript cache is unavailable.",
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });

  it("keeps blocked adapter storage observable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage blocked", "SecurityError");
      },
    });

    try {
      const state = sessionWithSegments(1);
      const adapter = createLocalOptimisticPendantTranscriptSessionAdapter();

      expect(() => savePendantTranscriptSession(state)).toThrow(
        "Pendant transcript cache is unavailable.",
      );
      expect(() => adapter.save(state)).toThrow(
        "Pendant transcript cache is unavailable.",
      );
      expect(() => adapter.load()).toThrow(
        "Pendant transcript cache is unavailable.",
      );
    } finally {
      if (descriptor) {
        Object.defineProperty(window, "localStorage", descriptor);
      }
    }
  });

  it("surfaces malformed storage as invalid", () => {
    const storage = new MemoryStorage();
    storage.setItem(PENDANT_TRANSCRIPT_STORAGE_KEY, "{not json");
    expect(() => loadPendantTranscriptSession(storage)).toThrow(
      "Pendant transcript cache contains malformed JSON.",
    );
  });
});
