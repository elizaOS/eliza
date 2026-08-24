/** Verifies useChatPrefill - floating-composer prefill dispatch through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Unit lock for the chat-prefill seeding hook.
 *
 * Any view can populate the single floating chat composer through this hook;
 * the always-mounted ChatOverlay consumes the result as a real
 * `eliza:chat:prefill` CustomEvent on `window`. The binding properties:
 *  1. `prefill(text)` dispatches CHAT_PREFILL_EVENT on window with detail
 *     `{ text, select: true }` — select defaults to true at this layer.
 *  2. An explicit second argument passes through unchanged.
 *  3. Text is delivered verbatim — no trimming, guarding, or transformation
 *     (an empty string still reaches the composer).
 *  4. Every call dispatches its own event, in call order, on `window`
 *     (the overlay's listen target).
 *  5. The returned `prefill` keeps a stable identity across re-renders so
 *     consumers can safely list it in effect dependencies.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CHAT_PREFILL_EVENT } from "../events";
import { useChatPrefill } from "./useChatPrefill";

interface PrefillDetail {
  text: string;
  select?: boolean;
}

/** Attach one real window listener; the overlay's consumption boundary. */
function listenForPrefill(): {
  events: CustomEvent<PrefillDetail>[];
  dispose: () => void;
} {
  const events: CustomEvent<PrefillDetail>[] = [];
  const handle = (event: Event): void => {
    events.push(event as CustomEvent<PrefillDetail>);
  };
  window.addEventListener(CHAT_PREFILL_EVENT, handle);
  return {
    events,
    dispose: () => window.removeEventListener(CHAT_PREFILL_EVENT, handle),
  };
}

afterEach(() => {
  cleanup();
});

describe("useChatPrefill", () => {
  it("dispatches CHAT_PREFILL_EVENT on window with the text and select=true default", () => {
    const { result } = renderHook(() => useChatPrefill());
    const { events, dispose } = listenForPrefill();
    // The overlay listens on window, not document — a document-level listener
    // must not see this event.
    const documentEvents: CustomEvent<PrefillDetail>[] = [];
    const documentHandle = (event: Event): void => {
      documentEvents.push(event as CustomEvent<PrefillDetail>);
    };
    document.addEventListener(CHAT_PREFILL_EVENT, documentHandle);
    try {
      act(() => {
        result.current.prefill("Summarize my notes");
      });

      expect(events).toHaveLength(1);
      expect(documentEvents).toHaveLength(0);
      expect(events[0].detail).toEqual({
        text: "Summarize my notes",
        select: true,
      });
    } finally {
      dispose();
      document.removeEventListener(CHAT_PREFILL_EVENT, documentHandle);
    }
  });

  it("passes an explicit select argument through unchanged", () => {
    const { result } = renderHook(() => useChatPrefill());
    const { events, dispose } = listenForPrefill();
    try {
      act(() => {
        result.current.prefill("draft without selection", false);
      });
      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({
        text: "draft without selection",
        select: false,
      });

      act(() => {
        result.current.prefill("draft with selection", true);
      });
      expect(events).toHaveLength(2);
      expect(events[1].detail).toEqual({
        text: "draft with selection",
        select: true,
      });
    } finally {
      dispose();
    }
  });

  it("delivers empty-string text verbatim without guarding it away", () => {
    const { result } = renderHook(() => useChatPrefill());
    const { events, dispose } = listenForPrefill();
    try {
      act(() => {
        result.current.prefill("");
      });

      expect(events).toHaveLength(1);
      expect(events[0].detail).toEqual({ text: "", select: true });
    } finally {
      dispose();
    }
  });

  it("dispatches one event per prefill call, in call order", () => {
    const { result } = renderHook(() => useChatPrefill());
    const { events, dispose } = listenForPrefill();
    try {
      act(() => {
        result.current.prefill("first");
        result.current.prefill("second");
        result.current.prefill("third");
      });

      expect(events.map((event) => event.detail.text)).toEqual([
        "first",
        "second",
        "third",
      ]);
    } finally {
      dispose();
    }
  });

  it("keeps a stable prefill identity across re-renders", () => {
    const { result, rerender } = renderHook(() => useChatPrefill());
    const first = result.current.prefill;

    rerender();

    expect(result.current.prefill).toBe(first);
  });
});
