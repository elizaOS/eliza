/**
 * Deterministic storage-contract coverage for lossless onboarding request
 * persistence and clear-on-consume behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __TEST_ONLY__,
  clearPendingFirstRunText,
  handoffPendingFirstRunText,
  readPendingFirstRunText,
  registerPendingFirstRunTextConsumer,
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
    clearPendingFirstRunText();
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

  it("retains requests across absent and unmounted consumers until acknowledgement", () => {
    const requests = ["first request", "second\nline"];
    writePendingFirstRunText(requests);
    releasePendingFirstRunText();
    expect(readPendingFirstRunText()).toEqual(requests);
    const delivered: string[] = [];
    const unregister = registerPendingFirstRunTextConsumer((text) =>
      delivered.push(text),
    );
    expect(delivered).toEqual([requests.join("\n\n")]);
    expect(readPendingFirstRunText()).toEqual(requests);
    unregister();
    const unregisterNext = registerPendingFirstRunTextConsumer(
      (text, acknowledge) => {
        delivered.push(text);
        acknowledge();
      },
    );
    expect(delivered).toEqual([requests.join("\n\n"), requests.join("\n\n")]);
    expect(readPendingFirstRunText()).toEqual([]);
    releasePendingFirstRunText();
    expect(delivered).toHaveLength(2);
    unregisterNext();
  });

  it("does not let an older acknowledgement clear a newer complete batch", () => {
    const acknowledgements: Array<() => void> = [];
    const unregister = registerPendingFirstRunTextConsumer(
      (_text, acknowledge) => acknowledgements.push(acknowledge),
    );
    handoffPendingFirstRunText(["first"]);
    handoffPendingFirstRunText(["first", "second"]);
    acknowledgements[0]();
    expect(readPendingFirstRunText()).toEqual(["first", "second"]);
    acknowledgements[1]();
    expect(readPendingFirstRunText()).toEqual([]);
    unregister();
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
