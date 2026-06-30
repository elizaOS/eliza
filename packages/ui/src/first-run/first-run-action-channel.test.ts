import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
  tryHandleFirstRunAction,
} from "./first-run-action-channel";

/**
 * The action channel is the seam that lets the chat's single send funnel
 * short-circuit first-run-scoped choice picks to the headless onboarding
 * conductor. Its load-bearing invariant: a first-run choice value must ONLY be
 * intercepted while a conductor is active — once onboarding finishes and clears
 * the handler, an identical-looking value must fall through to the real chat
 * send (no leak), and a non-prefixed value must never be intercepted.
 */

afterEach(() => {
  // Module-scoped handler — reset so cases don't bleed into each other.
  setFirstRunActionHandler(null);
});

describe("first-run action channel", () => {
  it("does not intercept when no conductor is registered", () => {
    expect(tryHandleFirstRunAction(`${FIRST_RUN_ACTION_PREFIX}use-cloud`)).toBe(
      false,
    );
  });

  it("routes a prefixed value to the active conductor's handler", () => {
    const handler = vi.fn(() => true);
    setFirstRunActionHandler(handler);

    const value = `${FIRST_RUN_ACTION_PREFIX}use-cloud`;
    expect(tryHandleFirstRunAction(value)).toBe(true);
    expect(handler).toHaveBeenCalledWith(value);
  });

  it("never intercepts a non-prefixed value, even with an active conductor", () => {
    const handler = vi.fn(() => true);
    setFirstRunActionHandler(handler);

    expect(tryHandleFirstRunAction("hello, this is a real message")).toBe(
      false,
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops intercepting once the conductor clears its handler (no leak after finish)", () => {
    const handler = vi.fn(() => true);
    setFirstRunActionHandler(handler);
    const value = `${FIRST_RUN_ACTION_PREFIX}use-cloud`;
    expect(tryHandleFirstRunAction(value)).toBe(true);

    // Onboarding finished → handler cleared. An identical value must now fall
    // through to the real chat send instead of being swallowed.
    setFirstRunActionHandler(null);
    expect(tryHandleFirstRunAction(value)).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("forwards the handler's verdict (a non-consuming handler does not block the send)", () => {
    setFirstRunActionHandler(() => false);
    expect(
      tryHandleFirstRunAction(`${FIRST_RUN_ACTION_PREFIX}unknown-choice`),
    ).toBe(false);
  });
});
