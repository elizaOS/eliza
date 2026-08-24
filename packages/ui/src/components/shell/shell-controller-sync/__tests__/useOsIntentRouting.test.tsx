// @vitest-environment jsdom
/**
 * The live hash-consumer tests prove trusted launches cross the owner command
 * boundary once, use review-only chat delivery, and remain retryable on failure.
 */
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOsIntentRouting } from "../useOsIntentRouting";
import type { ShellControllerSync } from "../useShellControllerSync";

function syncWith(
  dispatch: ShellControllerSync["dispatch"],
): ShellControllerSync {
  return {
    role: "owner",
    status: "connected",
    snapshot: null,
    endpointId: "owner",
    generation: 1,
    dispatch,
    publishSnapshot: vi.fn(),
    deliver: vi.fn(async () => {}),
    setCommandHandler: vi.fn(),
    setDeliveryHandler: vi.fn(),
    reportError: vi.fn(),
  };
}

describe("useOsIntentRouting", () => {
  beforeEach(() => window.history.replaceState(null, "", "/"));
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("routes a trusted send as review-only and clears it after owner handling", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?source=ios-app-intents&action=ask&text=hello&assistant.launchId=launch-1",
    );
    const dispatch = vi.fn(async () => {});
    renderHook(() => useOsIntentRouting(syncWith(dispatch)));

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "routeOsIntent",
      intent: {
        type: "send",
        intentId: "launch-1",
        source: "ios-app-intents",
        text: "hello",
      },
      deliveryPolicy: "review-send",
    });
    await waitFor(() => expect(window.location.hash).toBe("#chat"));
  });

  it("keeps a failed launch in the hash so it can be retried", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?source=siri&action=voice&voice=1&assistant.launchId=launch-fail",
    );
    const error = new Error("authority unavailable");
    const sync = syncWith(vi.fn(async () => Promise.reject(error)));
    renderHook(() => useOsIntentRouting(sync));

    await waitFor(() =>
      expect(sync.reportError).toHaveBeenCalledWith(
        "OS intent dispatch failed",
        error,
      ),
    );
    expect(window.location.hash).toContain("assistant.launchId=launch-fail");
  });

  it("does not dispatch an unknown source", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?source=attacker&action=voice&voice=1&assistant.launchId=bad",
    );
    const dispatch = vi.fn(async () => {});
    renderHook(() => useOsIntentRouting(syncWith(dispatch)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
    expect(window.location.hash).toContain("source=attacker");
  });

  it("consumes a later hashchange and routes non-send intents as execute", async () => {
    const dispatch = vi.fn(async () => {});
    renderHook(() => useOsIntentRouting(syncWith(dispatch)));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();

    window.history.replaceState(
      null,
      "",
      "/#voice?source=siri&voice=1&assistant.launchId=launch-voice",
    );
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith({
      kind: "routeOsIntent",
      intent: {
        type: "start-voice",
        intentId: "launch-voice",
        source: "siri",
        mode: "converse",
      },
      deliveryPolicy: "execute",
    });
    await waitFor(() => expect(window.location.hash).toBe("#voice"));
  });

  it("skips an intent whose dispatch is already in flight", async () => {
    window.history.replaceState(
      null,
      "",
      "/#voice?source=siri&voice=1&assistant.launchId=launch-inflight",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatch = vi.fn(() => gate);
    renderHook(() => useOsIntentRouting(syncWith(dispatch)));

    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("hashchange"));
    expect(dispatch).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => expect(window.location.hash).toBe("#voice"));
  });

  it("re-fires an intent after its first dispatch failed", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?source=siri&action=ask&text=retry&assistant.launchId=launch-retry",
    );
    let attempts = 0;
    const sync = syncWith(
      vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient dispatch failure");
      }),
    );
    renderHook(() => useOsIntentRouting(sync));

    await waitFor(() =>
      expect(sync.reportError).toHaveBeenCalledWith(
        "OS intent dispatch failed",
        expect.any(Error),
      ),
    );
    window.dispatchEvent(new Event("hashchange"));
    await waitFor(() => expect(attempts).toBe(2));
    await waitFor(() => expect(window.location.hash).toBe("#chat"));
  });

  it("leaves the launch payload when unmounted before dispatch settles", async () => {
    window.history.replaceState(
      null,
      "",
      "/#chat?source=siri&action=ask&text=late&assistant.launchId=launch-late",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { unmount } = renderHook(() =>
      useOsIntentRouting(syncWith(vi.fn(() => gate))),
    );
    unmount();

    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(window.location.hash).toContain("assistant.launchId=launch-late");
    expect(window.location.hash).not.toBe("#");
  });

  it("stops consuming hash changes after unmount", async () => {
    const dispatch = vi.fn(async () => {});
    const { unmount } = renderHook(() =>
      useOsIntentRouting(syncWith(dispatch)),
    );
    unmount();

    window.history.replaceState(
      null,
      "",
      "/#voice?source=siri&voice=1&assistant.launchId=launch-after-unmount",
    );
    window.dispatchEvent(new Event("hashchange"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dispatch).not.toHaveBeenCalled();
  });
});
