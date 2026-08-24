/**
 * Unit coverage for the boot-recovery action channel: reserved-prefix
 * classification and handler dispatch against the real module singleton.
 * Deterministic: the module-level handler is reset between tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_RECOVERY_ACTION_PREFIX,
  setBootRecoveryActionHandler,
  tryHandleBootRecoveryAction,
} from "./boot-recovery-channel";

/**
 * The boot-recovery channel routes the chat send funnel's `__boot_recovery__:`
 * control values to the headless boot-recovery conductor. Invariants under
 * test: a prefixed value is ALWAYS consumed (reported handled, never forwarded
 * to the server) whether or not a conductor is active, the handler receives the
 * full raw value, the handler's own verdict does not change consumption, and a
 * non-prefixed value is never intercepted.
 */

afterEach(() => {
  setBootRecoveryActionHandler(null);
});

describe("boot recovery action channel", () => {
  it("exposes the reserved sentinel prefix", () => {
    expect(BOOT_RECOVERY_ACTION_PREFIX).toBe("__boot_recovery__:");
  });

  it("routes a prefixed value to the active conductor's handler, passing the full raw value", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    const value = `${BOOT_RECOVERY_ACTION_PREFIX}relogin`;
    expect(tryHandleBootRecoveryAction(value)).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("__boot_recovery__:relogin");
  });

  it("consumes a prefixed value even with NO handler (never reaches the server)", () => {
    // A tap on a stale recovery-card control after recovery must not become a
    // literal `__boot_recovery__:` chat message.
    expect(
      tryHandleBootRecoveryAction(`${BOOT_RECOVERY_ACTION_PREFIX}retry`),
    ).toBe(true);
  });

  it("still consumes a prefixed value after the conductor clears its handler", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    setBootRecoveryActionHandler(null);
    const value = `${BOOT_RECOVERY_ACTION_PREFIX}retry-dedicated-agent`;
    expect(tryHandleBootRecoveryAction(value)).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  it("never intercepts a non-prefixed value, even with an active handler", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(tryHandleBootRecoveryAction("a real message")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not intercept a value that merely contains the prefix mid-string", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(
      tryHandleBootRecoveryAction(`see ${BOOT_RECOVERY_ACTION_PREFIX}docs`),
    ).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("treats the bare prefix itself as a consumable value", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(tryHandleBootRecoveryAction(BOOT_RECOVERY_ACTION_PREFIX)).toBe(true);
    expect(handler).toHaveBeenCalledWith(BOOT_RECOVERY_ACTION_PREFIX);
  });

  it("is case-sensitive about the sentinel prefix", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(tryHandleBootRecoveryAction("__BOOT_RECOVERY__:relogin")).toBe(
      false,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects the empty string without touching the handler", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(tryHandleBootRecoveryAction("")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("consumes based on the prefix alone, regardless of the handler's own verdict", () => {
    // The channel reports handled as soon as the value is reserved; whether the
    // conductor acted on it is the conductor's business.
    const decliningHandler = vi.fn(() => false);
    setBootRecoveryActionHandler(decliningHandler);
    expect(
      tryHandleBootRecoveryAction(`${BOOT_RECOVERY_ACTION_PREFIX}retry`),
    ).toBe(true);
    expect(decliningHandler).toHaveBeenCalledTimes(1);
  });

  it("dispatches only to the most recently registered handler", () => {
    const first = vi.fn(() => true);
    setBootRecoveryActionHandler(first);
    const second = vi.fn(() => true);
    setBootRecoveryActionHandler(second);
    const value = `${BOOT_RECOVERY_ACTION_PREFIX}relogin`;
    expect(tryHandleBootRecoveryAction(value)).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(value);
  });

  it("delivers each reserved value to the live handler across sequential sends", () => {
    const handler = vi.fn(() => true);
    setBootRecoveryActionHandler(handler);
    expect(
      tryHandleBootRecoveryAction(`${BOOT_RECOVERY_ACTION_PREFIX}relogin`),
    ).toBe(true);
    expect(
      tryHandleBootRecoveryAction(`${BOOT_RECOVERY_ACTION_PREFIX}retry`),
    ).toBe(true);
    expect(handler).toHaveBeenNthCalledWith(1, "__boot_recovery__:relogin");
    expect(handler).toHaveBeenNthCalledWith(2, "__boot_recovery__:retry");
  });
});
