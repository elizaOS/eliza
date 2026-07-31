/**
 * Verifies that client-scoped view state survives transient WebSocket loss but
 * is reclaimed after a bounded disconnect when no same-client socket remains.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelPendingViewScopeClear,
  DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS,
  registerViewScopeConnection,
  scheduleViewScopeClearAfterGrace,
} from "./view-scope-ws-lifecycle.ts";

describe("view-scope WebSocket lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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
  });

  it("cancels cleanup and marks the scope connected on reconnect", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();
    const markViewScopeConnected = vi.fn();
    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => false,
      clearViewScope,
    });
    vi.advanceTimersByTime(5_000);
    expect(
      registerViewScopeConnection({
        clientId: "client-a",
        pendingClears,
        markViewScopeConnected,
      }),
    ).toBe(true);
    vi.advanceTimersByTime(DEFAULT_VIEW_SCOPE_DISCONNECT_GRACE_MS);
    expect(clearViewScope).not.toHaveBeenCalled();
    expect(markViewScopeConnected).toHaveBeenCalledWith("client-a");
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
  });

  it("exposes explicit cancellation for shutdown and replacement sockets", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    scheduleViewScopeClearAfterGrace({
      clientId: "client-a",
      pendingClears,
      clientHasLiveConnection: () => false,
      clearViewScope: vi.fn(),
    });
    expect(cancelPendingViewScopeClear("client-a", pendingClears)).toBe(true);
    expect(cancelPendingViewScopeClear("client-a", pendingClears)).toBe(false);
  });

  it("cannot repopulate or fire cleanup timers after server teardown starts", () => {
    const pendingClears = new Map<string, ReturnType<typeof setTimeout>>();
    const clearViewScope = vi.fn();
    let shuttingDown = true;
    const schedule = () =>
      scheduleViewScopeClearAfterGrace({
        clientId: "client-a",
        pendingClears,
        clientHasLiveConnection: () => false,
        clearViewScope,
        shouldSchedule: () => !shuttingDown,
        graceMs: 10,
      });

    schedule();
    expect(pendingClears.size).toBe(0);

    shuttingDown = false;
    schedule();
    shuttingDown = true;
    vi.advanceTimersByTime(10);
    expect(clearViewScope).not.toHaveBeenCalled();
  });
});
