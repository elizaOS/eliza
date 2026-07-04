// Exercises signup grant amount behavior with deterministic cloud-shared lib fixtures.
import { afterEach, describe, expect, test } from "bun:test";
import { INITIAL_FREE_CREDITS } from "./services/wallet-signup";
import { DEFAULT_INITIAL_CREDITS, getInitialCredits } from "./steward-sync";

/**
 * #8427 — the signup welcome-bonus amount ($5) is defined independently in TWO
 * places: the Steward JWT signup path (steward-sync `DEFAULT_INITIAL_CREDITS`)
 * and the SIWE/wallet/x402 path (wallet-signup `INITIAL_FREE_CREDITS`). Both
 * read the same `INITIAL_FREE_CREDITS` env var but with separate defaults — a
 * change to one (e.g. back to 100) would silently make the two signup paths
 * grant different amounts. Pin both to the same value so the drift is caught.
 */
describe("#8427 signup-grant amount agreement", () => {
  const originalEnv = process.env.INITIAL_FREE_CREDITS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.INITIAL_FREE_CREDITS;
    else process.env.INITIAL_FREE_CREDITS = originalEnv;
  });

  test("both signup paths default to $5 (no give-away drift)", () => {
    // wallet-signup resolves INITIAL_FREE_CREDITS at module load; steward-sync's
    // default constant is the steward-path equivalent. They must agree.
    expect(DEFAULT_INITIAL_CREDITS).toBe(5);
    // INITIAL_FREE_CREDITS reflects the env at load time — in a clean test env
    // that is the default 5; if CI pins it, both paths still agree on it.
    expect(INITIAL_FREE_CREDITS).toBe(DEFAULT_INITIAL_CREDITS);
    expect(DEFAULT_INITIAL_CREDITS).not.toBe(100);
  });

  test("steward getInitialCredits honors the INITIAL_FREE_CREDITS override", () => {
    process.env.INITIAL_FREE_CREDITS = "12.5";
    expect(getInitialCredits()).toBe(12.5);
  });

  test("steward getInitialCredits rejects a negative override and falls back to the default", () => {
    process.env.INITIAL_FREE_CREDITS = "-3";
    expect(getInitialCredits()).toBe(DEFAULT_INITIAL_CREDITS);
  });

  test("steward getInitialCredits falls back to the default on a non-numeric override", () => {
    process.env.INITIAL_FREE_CREDITS = "abc";
    expect(getInitialCredits()).toBe(DEFAULT_INITIAL_CREDITS);
  });
});
