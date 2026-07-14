// @vitest-environment jsdom

/**
 * Covers cross-platform UI event delivery with real document/window events,
 * including acknowledged native intents that arrive before React mounts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_EVENT,
  dispatchAppEvent,
  dispatchBackIntent,
  dispatchWindowEvent,
  ELIZA_BACK_INTENT_EVENT,
  FOCUS_CONNECTOR_EVENT,
  VOICE_CONTROL_EVENT,
} from "./index";

describe("UI event delivery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("replays a native connect intent once a late consumer reads gatewayUrl", () => {
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: "http://127.0.0.1:31337",
      completeFirstRun: true,
    });

    const received: string[] = [];
    const listener = (event: Event) => {
      received.push(
        (event as CustomEvent<{ gatewayUrl: string }>).detail.gatewayUrl,
      );
    };
    document.addEventListener(CONNECT_EVENT, listener);
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(1_000);
    document.removeEventListener(CONNECT_EVENT, listener);

    expect(received).toEqual(["http://127.0.0.1:31337"]);
  });

  it("delivers exactly once when the consumer is already mounted", () => {
    const received: string[] = [];
    const listener = (event: Event) => {
      received.push(
        (event as CustomEvent<{ gatewayUrl: string }>).detail.gatewayUrl,
      );
    };
    document.addEventListener(CONNECT_EVENT, listener);
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: "https://agent.example.com",
    });
    vi.advanceTimersByTime(1_000);
    document.removeEventListener(CONNECT_EVENT, listener);

    expect(received).toEqual(["https://agent.example.com"]);
  });

  it("keeps replaying while a mounted startup consumer is not ready to claim", () => {
    let restoreComplete = false;
    const received: string[] = [];
    const listener = (event: Event) => {
      if (!restoreComplete) return;
      received.push(
        (event as CustomEvent<{ gatewayUrl: string }>).detail.gatewayUrl,
      );
    };
    document.addEventListener(CONNECT_EVENT, listener);
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: "http://127.0.0.1:31337",
      completeFirstRun: true,
    });

    vi.advanceTimersByTime(500);
    expect(received).toEqual([]);
    restoreComplete = true;
    vi.advanceTimersByTime(50);
    vi.advanceTimersByTime(1_000);
    document.removeEventListener(CONNECT_EVENT, listener);

    expect(received).toEqual(["http://127.0.0.1:31337"]);
  });

  it("surfaces an unconsumed connect intent after the bounded replay window", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    dispatchAppEvent(CONNECT_EVENT, {
      gatewayUrl: "https://agent.example.com",
    });
    vi.advanceTimersByTime(15_050);

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("no mounted consumer"),
    );
  });

  it("dispatches ordinary document and window events with their detail", () => {
    const documentDetails: unknown[] = [];
    const windowDetails: unknown[] = [];
    const documentListener = (event: Event) => {
      documentDetails.push((event as CustomEvent).detail);
    };
    const windowListener = (event: Event) => {
      windowDetails.push((event as CustomEvent).detail);
    };
    document.addEventListener(FOCUS_CONNECTOR_EVENT, documentListener);
    window.addEventListener(VOICE_CONTROL_EVENT, windowListener);

    dispatchAppEvent(FOCUS_CONNECTOR_EVENT, { connectorId: "discord" });
    dispatchWindowEvent(VOICE_CONTROL_EVENT, { command: "start" });

    document.removeEventListener(FOCUS_CONNECTOR_EVENT, documentListener);
    window.removeEventListener(VOICE_CONTROL_EVENT, windowListener);
    expect(documentDetails).toEqual([{ connectorId: "discord" }]);
    expect(windowDetails).toEqual([{ command: "start" }]);
  });

  it("reports whether a synchronous consumer handled Android back", () => {
    expect(dispatchBackIntent()).toBe(false);
    const listener = (event: Event) => {
      (event as CustomEvent<{ handled: boolean }>).detail.handled = true;
    };
    window.addEventListener(ELIZA_BACK_INTENT_EVENT, listener);

    expect(dispatchBackIntent()).toBe(true);

    window.removeEventListener(ELIZA_BACK_INTENT_EVENT, listener);
  });
});
