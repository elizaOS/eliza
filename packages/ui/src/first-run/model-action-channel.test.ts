import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isModelActionMessage,
  MODEL_ACTION_PREFIX,
  notifyTypedWhileBlocked,
  setModelActionHandler,
  setTypedWhileBlockedObserver,
  tryHandleModelAction,
} from "./model-action-channel";

/**
 * The model action channel is the seam that lets the chat's single send funnel
 * reach the headless model-status conductor. Its invariants: a `__model__:`
 * control is dispatched ONLY while a conductor is active, a non-prefixed value
 * is never intercepted, the prefix is recognised unconditionally (so a leftover
 * status widget tap is dropped, never sent), and the typed-while-blocked
 * observer reports whether the model currently blocks send.
 */

afterEach(() => {
  setModelActionHandler(null);
  setTypedWhileBlockedObserver(null);
});

describe("model action channel", () => {
  it("does not intercept when no conductor is registered", () => {
    expect(tryHandleModelAction(`${MODEL_ACTION_PREFIX}cancel`)).toBe(false);
  });

  it("routes a prefixed control to the active conductor's handler", () => {
    const handler = vi.fn(() => true);
    setModelActionHandler(handler);

    const value = `${MODEL_ACTION_PREFIX}cancel`;
    expect(tryHandleModelAction(value)).toBe(true);
    expect(handler).toHaveBeenCalledWith(value);
  });

  it("never intercepts a non-prefixed value, even with an active conductor", () => {
    const handler = vi.fn(() => true);
    setModelActionHandler(handler);

    expect(tryHandleModelAction("a normal chat message")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops intercepting once the conductor clears its handler", () => {
    const handler = vi.fn(() => true);
    setModelActionHandler(handler);
    const value = `${MODEL_ACTION_PREFIX}switch-cloud`;
    expect(tryHandleModelAction(value)).toBe(true);

    setModelActionHandler(null);
    expect(tryHandleModelAction(value)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("recognises the reserved prefix regardless of a registered handler", () => {
    // The funnel drops a leftover status-widget tap via isModelActionMessage
    // even after the conductor is gone — it must never reach the server.
    expect(isModelActionMessage(`${MODEL_ACTION_PREFIX}retry`)).toBe(true);
    expect(isModelActionMessage("switch to cloud please")).toBe(false);
  });
});

describe("typed-while-blocked observer", () => {
  it("returns false when no observer is registered", () => {
    expect(notifyTypedWhileBlocked()).toBe(false);
  });

  it("delegates to the registered observer and returns its verdict", () => {
    const observer = vi.fn(() => true);
    setTypedWhileBlockedObserver(observer);
    expect(notifyTypedWhileBlocked()).toBe(true);
    expect(observer).toHaveBeenCalledTimes(1);
  });

  it("reports not-blocking when the observer says the model is ready", () => {
    setTypedWhileBlockedObserver(() => false);
    expect(notifyTypedWhileBlocked()).toBe(false);
  });
});
