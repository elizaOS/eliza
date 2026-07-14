// @vitest-environment jsdom

/**
 * Covers acknowledged CONNECT_EVENT delivery across the native-listener to
 * React-consumer mount gap with fake time and real document events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_EVENT, dispatchAppEvent } from "./index";

describe("CONNECT_EVENT acknowledged delivery", () => {
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
});
