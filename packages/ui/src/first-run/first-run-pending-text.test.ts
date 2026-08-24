/**
 * Deterministic storage-contract coverage for lossless onboarding request
 * persistence and clear-on-consume behavior.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __TEST_ONLY__,
  clearPendingFirstRunText,
  readPendingFirstRunText,
  takePendingFirstRunText,
  writePendingFirstRunText,
} from "./first-run-pending-text";

function stubLocalStorage(): void {
  const items = new Map<string, string>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
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
});
