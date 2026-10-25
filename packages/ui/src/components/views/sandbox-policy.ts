/**
 * Sandbox-attribute policy for `sandboxed-iframe` views (#14180). A view at that
 * isolation level renders in an `<iframe sandbox>`; this module owns the one
 * security-critical invariant MDN warns about — an iframe that grants both
 * `allow-scripts` and `allow-same-origin` on same-origin content can reach back
 * out of the sandbox (it can rewrite its own `sandbox` attribute and re-run with
 * full privilege), so it is not a real sandbox at all. The shipped token set
 * therefore grants `allow-scripts` (the framed view needs to run) but never
 * `allow-same-origin`, which forces the document to an opaque origin: it cannot
 * touch the host's DOM, cookies, `localStorage`, or same-origin network — every
 * host facility must instead be requested through the postMessage broker.
 *
 * `resolveSandboxTokens` is the single constructor of the attribute string and
 * `assertRealSandbox` is the grep-able guard both this module and the frame
 * component run before rendering, so a future edit that widens the token set can
 * never silently re-introduce the foot-gun. Consumed by `SandboxedViewFrame.tsx`;
 * unit-tested in `sandbox-policy.test.ts`.
 */

/** The token that lets the framed view execute — the only privilege it needs. */
const ALLOW_SCRIPTS = "allow-scripts";

/**
 * The token that keeps the frame on the host origin. Combined with
 * {@link ALLOW_SCRIPTS} it defeats the sandbox (MDN), so it is never emitted for
 * an untrusted view — its presence alongside `allow-scripts` is the exact
 * condition {@link assertRealSandbox} rejects.
 */
const ALLOW_SAME_ORIGIN = "allow-same-origin";

/**
 * The default sandbox token set for an untrusted framed view: scripts may run,
 * but the document is forced to an opaque origin (no `allow-same-origin`), so it
 * has no ambient access to host storage, cookies, or the parent DOM. Everything
 * it needs from the shell goes through the capability broker.
 */
export const SANDBOXED_VIEW_TOKENS: readonly string[] = [ALLOW_SCRIPTS];

/** Raised when a requested sandbox token set would not be a real sandbox. */
export class SandboxPolicyError extends Error {
  constructor(reason: string) {
    super(`Refusing to render a non-isolating iframe sandbox: ${reason}`);
    this.name = "SandboxPolicyError";
  }
}

/**
 * Whether a token set is a real sandbox for untrusted content. It is not when it
 * grants scripts AND same-origin at once — that pairing lets the framed document
 * escape (MDN). Every other combination (scripts alone, same-origin alone, no
 * scripts) is genuinely isolating for our purposes.
 */
export function isRealSandbox(tokens: readonly string[]): boolean {
  const set = new Set(tokens);
  return !(set.has(ALLOW_SCRIPTS) && set.has(ALLOW_SAME_ORIGIN));
}

/**
 * Throw {@link SandboxPolicyError} unless `tokens` is a real sandbox. Called
 * before the frame is created so a decorative sandbox can never render.
 */
export function assertRealSandbox(tokens: readonly string[]): void {
  if (!isRealSandbox(tokens)) {
    throw new SandboxPolicyError(
      "`allow-scripts` and `allow-same-origin` together let the framed view " +
        "rewrite its own sandbox and run with full host privilege",
    );
  }
}

/**
 * Build the `sandbox` attribute string for a framed view. Extra tokens a view
 * asks for are unioned with the safe default, then validated — a request that
 * would defeat the sandbox throws rather than downgrading isolation silently.
 * The returned tokens are sorted so the attribute is deterministic (stable
 * across renders and snapshot-friendly).
 */
export function resolveSandboxTokens(extra: readonly string[] = []): string {
  const tokens = [...new Set([...SANDBOXED_VIEW_TOKENS, ...extra])].sort();
  assertRealSandbox(tokens);
  return tokens.join(" ");
}
