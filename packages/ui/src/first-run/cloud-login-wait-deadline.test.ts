/**
 * Covers the bounded cloud sign-in wait (#19255): the deadline fires once,
 * cancel prevents it and is idempotent (including after fire), and the
 * attempt guard makes abandoned/superseded attempt outcomes stale.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armCloudLoginWaitDeadline,
  CLOUD_LOGIN_WAIT_DEADLINE_MS,
  createAttemptGuard,
} from "./cloud-login-wait-deadline";

describe("armCloudLoginWaitDeadline", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fires once at the default deadline", () => {
    const onDeadline = vi.fn();
    armCloudLoginWaitDeadline({ onDeadline });
    vi.advanceTimersByTime(CLOUD_LOGIN_WAIT_DEADLINE_MS - 1);
    expect(onDeadline).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CLOUD_LOGIN_WAIT_DEADLINE_MS * 2);
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents the deadline when the flow settles first", () => {
    const onDeadline = vi.fn();
    const handle = armCloudLoginWaitDeadline({
      onDeadline,
      deadlineMs: 1000,
    });
    vi.advanceTimersByTime(500);
    handle.cancel();
    vi.advanceTimersByTime(5000);
    expect(onDeadline).not.toHaveBeenCalled();
  });

  it("cancel is idempotent and safe after fire", () => {
    const onDeadline = vi.fn();
    const handle = armCloudLoginWaitDeadline({
      onDeadline,
      deadlineMs: 100,
    });
    vi.advanceTimersByTime(100);
    expect(onDeadline).toHaveBeenCalledTimes(1);
    handle.cancel();
    handle.cancel();
    expect(onDeadline).toHaveBeenCalledTimes(1);
  });
});

describe("createAttemptGuard", () => {
  it("marks earlier attempts stale when a new one begins", () => {
    const guard = createAttemptGuard();
    const first = guard.begin();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.begin();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("invalidate makes the current attempt stale without starting a new one", () => {
    const guard = createAttemptGuard();
    const id = guard.begin();
    guard.invalidate();
    expect(guard.isCurrent(id)).toBe(false);
  });
});
