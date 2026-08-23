/**
 * Unit coverage for the portable fetch-timeout helpers in api/timeout-signal.ts.
 * Real harness: drives createTimeoutSignal through both its native
 * AbortSignal.timeout branch and its AbortController+setTimeout fallback
 * (native factory removed from the global for the duration of each fallback
 * case), with fake timers making the fallback bounds deterministic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeoutSignal, isTimeoutAbortError } from "./timeout-signal";

type AbortSignalTimeoutGlobal = {
  timeout?: (ms: number) => AbortSignal;
};

const nativeTimeoutDescriptor = Object.getOwnPropertyDescriptor(
  AbortSignal,
  "timeout",
);

function removeNativeTimeout(): void {
  delete (AbortSignal as unknown as AbortSignalTimeoutGlobal).timeout;
}

function restoreNativeTimeout(): void {
  if (nativeTimeoutDescriptor) {
    Object.defineProperty(AbortSignal, "timeout", nativeTimeoutDescriptor);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { reason?: unknown }).reason;
}

describe("createTimeoutSignal", () => {
  describe("native AbortSignal.timeout branch", () => {
    it.runIf(typeof AbortSignal.timeout === "function")(
      "returns a live AbortSignal with a callable dispose",
      () => {
        const { signal, dispose } = createTimeoutSignal(5_000);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
        expect(typeof dispose).toBe("function");
        dispose();
        expect(signal.aborted).toBe(false);
      },
    );

    it.runIf(typeof AbortSignal.timeout === "function")(
      "aborts with a TimeoutError reason once the deadline passes",
      async () => {
        const { signal, dispose } = createTimeoutSignal(5);
        const reason = await new Promise<unknown>((resolve) => {
          signal.addEventListener("abort", () => resolve(abortReason(signal)), {
            once: true,
          });
        });
        dispose();
        expect((reason as { name?: string }).name).toBe("TimeoutError");
      },
    );

    it.runIf(typeof AbortSignal.timeout === "function")(
      "keeps the deadline active when disposed early",
      async () => {
        const { signal, dispose } = createTimeoutSignal(5);
        dispose();
        const reason = await new Promise<unknown>((resolve) => {
          signal.addEventListener("abort", () => resolve(abortReason(signal)), {
            once: true,
          });
        });
        expect((reason as { name?: string }).name).toBe("TimeoutError");
      },
    );
  });

  describe("AbortController + setTimeout fallback", () => {
    beforeEach(() => {
      removeNativeTimeout();
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
      restoreNativeTimeout();
    });

    it("returns an un-aborted signal through the last tick before the deadline", () => {
      const { signal, dispose } = createTimeoutSignal(1_000);
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(999);
      expect(signal.aborted).toBe(false);
      dispose();
    });

    it("aborts at exactly the requested delay with a TimeoutError DOMException naming the budget", () => {
      const { signal, dispose } = createTimeoutSignal(1_234);
      vi.advanceTimersByTime(1_234);
      expect(signal.aborted).toBe(true);
      const reason = abortReason(signal);
      expect(reason).toBeInstanceOf(DOMException);
      expect((reason as { name?: string }).name).toBe("TimeoutError");
      expect((reason as { message?: string }).message).toBe(
        "Timeout after 1234 ms",
      );
      dispose();
    });

    it("never aborts once dispose cleared the pending timer", () => {
      let aborts = 0;
      const { signal, dispose } = createTimeoutSignal(1_000);
      signal.addEventListener("abort", () => {
        aborts += 1;
      });
      dispose();
      vi.advanceTimersByTime(60_000);
      expect(aborts).toBe(0);
      expect(signal.aborted).toBe(false);
    });

    it("aborts exactly once however far past the deadline time advances", () => {
      let aborts = 0;
      const { signal, dispose } = createTimeoutSignal(250);
      signal.addEventListener("abort", () => {
        aborts += 1;
      });
      vi.advanceTimersByTime(5_000);
      expect(aborts).toBe(1);
      expect(signal.aborted).toBe(true);
      dispose();
    });

    it("produces an error isTimeoutAbortError recognizes", () => {
      const { signal, dispose } = createTimeoutSignal(500);
      vi.advanceTimersByTime(500);
      expect(isTimeoutAbortError(abortReason(signal))).toBe(true);
      dispose();
    });
  });
});

describe("isTimeoutAbortError", () => {
  it("recognizes the native TimeoutError spelling", () => {
    expect(isTimeoutAbortError(new DOMException("late", "TimeoutError"))).toBe(
      true,
    );
  });

  it("recognizes the plain-abort spelling", () => {
    expect(isTimeoutAbortError(new DOMException("stopped", "AbortError"))).toBe(
      true,
    );
  });

  it("matches by name on plain objects", () => {
    expect(isTimeoutAbortError({ name: "TimeoutError" })).toBe(true);
    expect(isTimeoutAbortError({ name: "AbortError" })).toBe(true);
  });

  it("rejects other error kinds", () => {
    expect(isTimeoutAbortError(new Error("boom"))).toBe(false);
    expect(isTimeoutAbortError(new TypeError("bad input"))).toBe(false);
    expect(
      isTimeoutAbortError(new DOMException("refused", "NetworkError")),
    ).toBe(false);
    expect(isTimeoutAbortError({ name: "SyntaxError" })).toBe(false);
  });

  it("rejects non-object inputs", () => {
    expect(isTimeoutAbortError(null)).toBe(false);
    expect(isTimeoutAbortError(undefined)).toBe(false);
    expect(isTimeoutAbortError("TimeoutError")).toBe(false);
    expect(isTimeoutAbortError(42)).toBe(false);
    expect(isTimeoutAbortError(true)).toBe(false);
  });

  it("rejects objects without a usable name", () => {
    expect(isTimeoutAbortError({})).toBe(false);
    expect(isTimeoutAbortError({ message: "Timeout after 1000 ms" })).toBe(
      false,
    );
    expect(isTimeoutAbortError({ name: null })).toBe(false);
    expect(isTimeoutAbortError({ name: 7 })).toBe(false);
  });
});
