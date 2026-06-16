/**
 * Decides whether the Playwright UI-smoke stack must serve the deterministic
 * stub API (`playwright-ui-smoke-api-stub.mjs`) instead of a real app-core
 * runtime.
 *
 * The precedence matters and is easy to get subtly wrong, which is why it lives
 * in one tested function instead of inline boolean soup:
 *
 *   1. `ELIZA_UI_SMOKE_FORCE_STUB=1` always wins — keyless lanes opt in here and
 *      must stay deterministic regardless of anything else.
 *   2. An explicit live-stack opt-in (`ELIZA_UI_SMOKE_LIVE_STACK=1`) overrides
 *      the CI-based force. GitHub Actions always sets `CI=true`; without this
 *      override a genuinely-real lane is impossible because CI would re-force
 *      the stub even when the operator supplied a provider key and asked for the
 *      real backend. This is the seam the gated live e2e lane drives through.
 *   3. Otherwise `CI=true` forces the stub (the historical default).
 *
 * Note that the *runner* (`packages/app/scripts/run-ui-playwright.mjs`) only sets
 * `ELIZA_UI_SMOKE_FORCE_STUB` when `ELIZA_UI_SMOKE_LIVE_STACK !== "1"`, so in the
 * normal path force-stub and live-stack are mutually exclusive; this function
 * still defines a total ordering for the case where both are set.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean} true when the stub stack must be used.
 */
export function shouldForceStubStack(env) {
  const forceStub = env.ELIZA_UI_SMOKE_FORCE_STUB === "1";
  if (forceStub) {
    return true;
  }
  const allowLiveStack = env.ELIZA_UI_SMOKE_LIVE_STACK === "1";
  return env.CI === "true" && !allowLiveStack;
}
