// @vitest-environment jsdom

/**
 * Connection-event handoff coverage for native deep links that can arrive
 * before React mounts a startup or live-shell consumer.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchConnectRequest, listenForConnectRequests } from "./index";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("connect request handoff", () => {
  it("replays a request dispatched before the consumer mounts", async () => {
    const listener = vi.fn();

    dispatchConnectRequest({
      gatewayUrl: "http://127.0.0.1:31337",
      completeFirstRun: true,
    });
    cleanups.push(listenForConnectRequests(listener));
    await Promise.resolve();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayUrl: "http://127.0.0.1:31337",
        completeFirstRun: true,
      }),
    );
  });

  it("lets only one startup/shell consumer claim a queued request", async () => {
    const startupListener = vi.fn();
    const shellListener = vi.fn();

    dispatchConnectRequest({ gatewayUrl: "http://127.0.0.1:31337" });
    cleanups.push(listenForConnectRequests(startupListener));
    cleanups.push(listenForConnectRequests(shellListener));
    await Promise.resolve();

    expect(startupListener).toHaveBeenCalledOnce();
    expect(shellListener).not.toHaveBeenCalled();
  });

  it("delivers requests immediately after a consumer mounts", () => {
    const listener = vi.fn();
    cleanups.push(listenForConnectRequests(listener));

    dispatchConnectRequest({ gatewayUrl: "https://agent.example.com" });

    expect(listener).toHaveBeenCalledOnce();
  });
});
