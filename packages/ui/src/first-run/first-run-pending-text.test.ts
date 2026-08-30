/**
 * Deterministic storage-contract coverage for lossless onboarding request
 * persistence and clear-on-consume behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_PREFILL_EVENT, type ChatPrefillEventDetail } from "../events";
import {
  __TEST_ONLY__,
  clearPendingFirstRunText,
  readPendingFirstRunText,
  releasePendingFirstRunText,
  setPendingFirstRunTextReleaseHandler,
  takePendingFirstRunText,
  writePendingFirstRunText,
} from "./first-run-pending-text";

function stubLocalStorage(): void {
  const items = new Map<string, string>();
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      addEventListener: events.addEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
      localStorage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
        removeItem: (key: string) => void items.delete(key),
      },
    },
  });
}

describe("pending first-run text", () => {
  beforeEach(() => stubLocalStorage());
  afterEach(() => {
    setPendingFirstRunTextReleaseHandler(null);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: undefined,
    });
  });

  it("round-trips every request in order without changing its text", () => {
    const requests = [
      "Research quiet hotels near the venue.",
      "Keep the budget under $300 exactly.\nPreserve this second line.",
    ];
    writePendingFirstRunText(requests);
    expect(readPendingFirstRunText()).toEqual(requests);
  });

  it("returns the complete list exactly once", () => {
    writePendingFirstRunText(["first", "second"]);
    expect(takePendingFirstRunText()).toEqual(["first", "second"]);
    expect(takePendingFirstRunText()).toEqual([]);
  });

  it("rejects a corrupt payload as a whole and clears it", () => {
    window.localStorage.setItem(
      __TEST_ONLY__.PENDING_FIRST_RUN_TEXT_STORAGE_KEY,
      JSON.stringify(["valid", 42]),
    );
    expect(readPendingFirstRunText()).toEqual([]);
    expect(
      window.localStorage.getItem(
        __TEST_ONLY__.PENDING_FIRST_RUN_TEXT_STORAGE_KEY,
      ),
    ).toBeNull();
  });

  it("clears explicitly", () => {
    writePendingFirstRunText(["request"]);
    clearPendingFirstRunText();
    expect(readPendingFirstRunText()).toEqual([]);
  });

  it("releases the durable requests to the composer exactly once", async () => {
    const prefill = vi.fn<(event: Event) => void>();
    window.addEventListener(CHAT_PREFILL_EVENT, prefill);
    writePendingFirstRunText(["first request", "second\nline"]);

    releasePendingFirstRunText();
    await Promise.resolve();
    releasePendingFirstRunText();
    await Promise.resolve();

    expect(prefill).toHaveBeenCalledTimes(1);
    expect(
      (prefill.mock.calls[0][0] as CustomEvent<ChatPrefillEventDetail>).detail,
    ).toEqual({
      text: "first request\n\nsecond\nline",
      select: true,
    });
  });

  it("prefers the active conductor's lossless in-memory release seam", () => {
    const release = vi.fn();
    setPendingFirstRunTextReleaseHandler(release);
    writePendingFirstRunText(["durable fallback"]);

    releasePendingFirstRunText();

    expect(release).toHaveBeenCalledTimes(1);
    expect(readPendingFirstRunText()).toEqual(["durable fallback"]);
  });
});
