/**
 * Unit coverage for the first-run model-action channel: value classification and
 * handler dispatch. Pure functions + injected handler.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isModelActionValue,
  MODEL_ACTION_PREFIX,
  setModelActionHandler,
  tryHandleModelAction,
} from "./model-action-channel";

/**
 * The model action channel routes the in-chat model-status card's `__model__:`
 * controls to the headless conductor. Invariants: a `__model__:` value is
 * ALWAYS consumed (never reaches the server) whether or not a conductor is
 * active, and a non-model value is never intercepted.
 */

afterEach(() => {
  setModelActionHandler(null);
});

describe("model action channel", () => {
  it("identifies reserved-prefix values", () => {
    expect(isModelActionValue(`${MODEL_ACTION_PREFIX}cancel`)).toBe(true);
    expect(isModelActionValue("hello")).toBe(false);
  });

  it("routes a prefixed value to the active conductor's handler", () => {
    const handler = vi.fn(() => true);
    setModelActionHandler(handler);
    const value = `${MODEL_ACTION_PREFIX}cancel`;
    expect(tryHandleModelAction(value)).toBe(true);
    expect(handler).toHaveBeenCalledWith(value);
  });

  it("consumes a reserved-prefix value even with NO conductor (never reaches the server)", () => {
    // A tap on a stale status-card control after the model is ready must not
    // become a literal `__model__:` chat message.
    expect(tryHandleModelAction(`${MODEL_ACTION_PREFIX}cancel`)).toBe(true);
  });

  it("never intercepts a non-model value, even with an active conductor", () => {
    const handler = vi.fn(() => true);
    setModelActionHandler(handler);
    expect(tryHandleModelAction("a real message")).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
