import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyActionMessage,
  FIRST_RUN_ACTION_PREFIX,
  setFirstRunActionHandler,
  tryHandleFirstRunAction,
} from "./first-run-action-channel";

/**
 * The action channel is the seam that lets the chat's single send funnel
 * short-circuit first-run-scoped choice picks to the headless onboarding
 * conductor. Its load-bearing invariants: a first-run choice value is ONLY
 * dispatched to a conductor while one is active, a non-prefixed value is never
 * intercepted, and — via `classifyActionMessage` — a reserved-prefix value is
 * NEVER forwarded to the server as a chat message, even after onboarding
 * finished and the handler is gone (leftover transcript widgets stay inert).
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

    // Onboarding finished → handler cleared. The channel no longer dispatches
    // the value (the send funnel's classifier still drops it — see below).
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

describe("classifyActionMessage (the send funnel's routing contract)", () => {
  it("reserves the prefix unconditionally — before AND after onboarding", () => {
    const value = `${FIRST_RUN_ACTION_PREFIX}runtime:local`;
    expect(classifyActionMessage(value, false)).toBe("first-run");
    // The load-bearing case: onboarding is complete, the conductor is gone,
    // and a user taps a leftover onboarding widget in the transcript. The
    // literal sentinel must NOT become a chat message to the agent.
    expect(classifyActionMessage(value, true)).toBe("first-run");
  });

  it("drops free text while onboarding is active and sends it afterwards", () => {
    expect(classifyActionMessage("hello", false)).toBe("dropped");
    expect(classifyActionMessage("hello", true)).toBe("send");
  });
});
