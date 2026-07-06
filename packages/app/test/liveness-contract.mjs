/**
 * The onboarding liveness contract: the single, surface-agnostic rule that a
 * post-onboarding chat reply came from a REAL model and not the deterministic
 * stub. Consumed by the Playwright wrapper (`liveness-contract.ts`), the iOS
 * simulator harness (`scripts/ios-onboarding-smoke.mjs`), and the in-app iOS
 * verifier (`src/main.tsx`) — every onboarding surface asserts liveness through
 * this one implementation so the check cannot drift between lanes (#14359).
 *
 * This module is intentionally pure and dependency-free (plain `.mjs`) so it is
 * importable from both the bundled renderer and the un-bundled Node harness
 * without a build step. All DOM/Playwright driving lives in the `.ts` wrapper.
 */

/**
 * The deterministic keyless stub tags every reply with this fixture id. A real
 * model turn must never contain it — that is how liveness is proven. Kept here
 * as the one source of truth; the stub emitter
 * (`packages/app-core/scripts/playwright-ui-smoke-api-stub.mjs`) writes the same
 * literal, so if that fixture id ever changes both sides update together.
 */
export const STUB_FIXTURE_MARKER = "ui-smoke-assistant-v1";

/**
 * Thrown when a reply fails the liveness contract. Distinct type so harnesses
 * can attribute a failure to liveness rather than a generic timeout/DOM error.
 */
export class LivenessAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "LivenessAssertionError";
  }
}

/**
 * Assert a rendered assistant reply proves a real model answered.
 *
 * A live reply must be a non-empty string that does not carry the stub fixture
 * marker. Empty/whitespace-only conflates "model never answered" with a real
 * turn; the stub marker conflates the deterministic fixture with a real turn —
 * both are false-green failures this contract exists to catch. Throws
 * `LivenessAssertionError` on failure; returns the trimmed reply on success.
 *
 * @param {unknown} reply the assistant reply text as rendered in the UI
 * @param {{ label?: string }} [options] label for error attribution (lane name)
 * @returns {string} the trimmed, validated reply
 */
export function assertLiveReply(reply, options = {}) {
  const label = options.label ? `${options.label}: ` : "";
  if (typeof reply !== "string") {
    throw new LivenessAssertionError(
      `${label}liveness reply must be a string, got ${reply === null ? "null" : typeof reply}`,
    );
  }
  const text = reply.trim();
  if (text.length === 0) {
    throw new LivenessAssertionError(
      `${label}liveness reply was empty — the model produced no answer`,
    );
  }
  if (text.includes(STUB_FIXTURE_MARKER)) {
    throw new LivenessAssertionError(
      `${label}liveness reply carried the stub fixture marker "${STUB_FIXTURE_MARKER}" — a real model did not answer`,
    );
  }
  return text;
}

/**
 * Non-throwing predicate form of {@link assertLiveReply}, for harnesses that
 * branch on liveness rather than fail. Returns true only for a real reply.
 *
 * @param {unknown} reply
 * @returns {boolean}
 */
export function isLiveReply(reply) {
  try {
    assertLiveReply(reply);
    return true;
  } catch {
    // error-policy:J3 predicate form — a rejected reply is a definite "not live"
    // signal, never a swallowed error (the throwing form is the enforcement path)
    return false;
  }
}
