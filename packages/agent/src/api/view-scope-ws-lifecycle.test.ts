/**
 * Verifies that client-scoped view state survives transient WebSocket loss but
 * is reclaimed after a bounded disconnect when no same-client socket remains.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingViewScopeClear,
  DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS,
  scheduleViewScopeClearAfterGrace,
} from "./view-scope-ws-lifecycle.ts";

describe("view-scope WebSocket lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves scoped state during the grace period, then clears that client only", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const scopes = new Map([
      ["client-a", "notes"],
      ["client-b", "calendar"],
    ]);

    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => false,
      clearViewScope: (clientId) => void scopes.delete(clientId),
    });

    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS - 1);
    expect(scopes.get("client-a")).toBe("notes");

    vi.advanceTimersByTime(1);
    expect(scopes.has("client-a")).toBe(false);
    expect(scopes.get("client-b")).toBe("calendar");
    expect(pendingClears.size).toBe(0);
  });

  it("cancels cleanup when the client reconnects within the grace period", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();

    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => false,
      clearViewScope,
    });

    vi.advanceTimersByTime(5_000);
    expect(cancelPendingViewScopeClear("client-a", pendingClears)).toBe(true);
    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);

    expect(clearViewScope).not.toHaveBeenCalled();
    expect(pendingClears.size).toBe(0);
  });

  it("does not schedule while another live socket shares the client id", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();

    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => true,
      clearViewScope,
    });

    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);
    expect(clearViewScope).not.toHaveBeenCalled();
    expect(pendingClears.size).toBe(0);
  });

  it("rechecks liveness when the timer fires if reconnect cancellation races", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();
    let connected = false;

    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => connected,
      clearViewScope,
    });

    connected = true;
    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);

    expect(clearViewScope).not.toHaveBeenCalled();
    expect(pendingClears.size).toBe(0);
  });

  it("restarts the full grace period after a repeated disconnect", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();
    const schedule = () =>
      scheduleViewScopeClearAfterGrace({
        clientId: "client-a",
        pendingClears,
        clientHasLiveConnection: () => false,
        clearViewScope,
      });

    schedule();
    vi.advanceTimersByTime(20_000);
    schedule();
    vi.advanceTimersByTime(20_000);
    expect(clearViewScope).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10_000);
    expect(clearViewScope).toHaveBeenCalledOnce();
  });
});
