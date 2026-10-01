// @vitest-environment jsdom
/**
 * The live hash-consumer tests prove trusted launches cross the owner command
 * boundary once, use review-only chat delivery, and remain retryable on failure.
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
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
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, "", "/");
  });

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

  it("consumes every queued hash event and retains a newer launch until it completes", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const dispatch = vi.fn(
      (command: Parameters<ShellControllerSync["dispatch"]>[0]) => {
        if (command.kind !== "routeOsIntent")
          throw new Error("Unexpected command");
        return command.intent.intentId === "queued-first"
          ? first.promise
          : second.promise;
      },
    );
    const sync = syncWith(dispatch);
    renderHook(() => useOsIntentRouting(sync));
    window.location.hash =
      "#chat?source=siri&action=ask&text=first&assistant.launchId=queued-first";
    window.location.hash =
      "#chat?source=siri&action=ask&text=second&assistant.launchId=queued-second";
    await waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(
      dispatch.mock.calls.map(([command]) =>
        command.kind === "routeOsIntent" ? command.intent.intentId : null,
      ),
    ).toEqual(["queued-first", "queued-second"]);
    await act(async () => first.resolve());
    expect(window.location.hash).toContain("assistant.launchId=queued-second");
    await act(async () => second.resolve());
    await waitFor(() => expect(window.location.hash).toBe("#chat"));
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
});
