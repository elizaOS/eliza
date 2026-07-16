// @vitest-environment jsdom
/**
 * React integration for the coordinator host: two windows on one in-memory bus
 * elect a single owner, the follower renders the owner's published snapshot, and
 * a follower command reaches the owner's handler — the whole single-engine
 * contract, exercised through real hooks and timers (no mock of the unit).
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHELL_OWNER_PRIORITY, type ShellControllerCommand } from "../protocol";
import { createInMemoryShellSyncBus } from "../transport";
import { useShellControllerSync } from "../useShellControllerSync";
import { baseSnapshot } from "./fixtures";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useShellControllerSync multi-window", () => {
  it("elects one owner; follower renders shared state and commands reach the owner", async () => {
    const bus = createInMemoryShellSyncBus();
    const ownerView = renderHook(() =>
      useShellControllerSync({
        transport: bus.connect(),
        windowId: "aaa-main",
        priority: SHELL_OWNER_PRIORITY.main,
      }),
    );
    const followerView = renderHook(() =>
      useShellControllerSync({
        transport: bus.connect(),
        windowId: "zzz-surface",
        priority: SHELL_OWNER_PRIORITY.surface,
      }),
    );

    // The main window claims immediately; the surface window waits out the
    // discovery grace and, hearing the owner, stays a follower.
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(ownerView.result.current.role).toBe("owner");
    expect(followerView.result.current.role).toBe("follower");

    const applied: ShellControllerCommand[] = [];
    act(() => {
      ownerView.result.current.setCommandHandler((command) =>
        applied.push(command),
      );
    });

    act(() => {
      ownerView.result.current.publishSnapshot(
        baseSnapshot({ transcript: "shared", recording: true }),
      );
    });
    expect(followerView.result.current.snapshot?.transcript).toBe("shared");
    expect(followerView.result.current.snapshot?.recording).toBe(true);

    await act(async () => {
      await followerView.result.current.dispatch({ kind: "startRecording" });
    });
    expect(applied).toEqual([{ kind: "startRecording" }]);
  });

  it("a lone window (no transport) is owner immediately with no bus traffic", () => {
    const view = renderHook(() =>
      useShellControllerSync({ transport: null, windowId: "solo" }),
    );
    // No grace, no flash: owner from the first committed render.
    expect(view.result.current.role).toBe("owner");
  });
});
