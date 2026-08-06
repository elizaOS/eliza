// @vitest-environment jsdom
/**
 * Browser-host intent tests exercise the real hash decoder, restored-session
 * dedupe persistence, storage-failure reporting, and review-only composer event.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeOsIntentFromHash,
  dispatchOsIntentComposerPrefill,
  loadOsIntentDedupeSnapshot,
  OS_INTENT_COMPOSER_PREFILL_EVENT,
  saveOsIntentDedupeSnapshot,
} from "./host";

describe("OS-intent browser host", () => {
  beforeEach(() => localStorage.clear());

  it("reconstructs and decodes the app shell's hash handoff", () => {
    const result = decodeOsIntentFromHash(
      "#chat?source=ios-app-intents&action=ask&text=hello&assistant.launchId=launch-1&issuedAt=42",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent).toMatchObject({
        type: "send",
        intentId: "launch-1",
        source: "ios-app-intents",
        text: "hello",
        issuedAt: 42,
      });
    }
  });

  it("round-trips successful intent records across a restored session", () => {
    expect(
      saveOsIntentDedupeSnapshot([{ intentId: "done", appliedAt: 100 }]),
    ).toBe(true);
    expect(loadOsIntentDedupeSnapshot()).toEqual([
      { intentId: "done", appliedAt: 100 },
    ]);
  });

  it("rejects corrupt persisted state and reports a write failure", () => {
    expect(
      saveOsIntentDedupeSnapshot([{ intentId: "done", appliedAt: 100 }]),
    ).toBe(true);
    const key = localStorage.key(0);
    expect(key).not.toBeNull();
    localStorage.setItem(key as string, "not-json");
    expect(loadOsIntentDedupeSnapshot()).toEqual([]);

    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });
    expect(saveOsIntentDedupeSnapshot([])).toBe(false);
    setItem.mockRestore();
  });

  it("delivers external text as a review-only composer event", () => {
    const listener = vi.fn();
    window.addEventListener(OS_INTENT_COMPOSER_PREFILL_EVENT, listener);
    dispatchOsIntentComposerPrefill("review me");
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0]?.[0];
    expect(event).toBeInstanceOf(CustomEvent);
    expect((event as CustomEvent).detail).toEqual({
      text: "review me",
    });
    window.removeEventListener(OS_INTENT_COMPOSER_PREFILL_EVENT, listener);
  });
});
