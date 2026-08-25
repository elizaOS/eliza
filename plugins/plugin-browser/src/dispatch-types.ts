/**
 * Capability-aware dispatch contract for BrowserService (issue #18258).
 *
 * BrowserService historically resolved a target by probing each candidate's
 * `available()` and then *retried* `execute()` across every candidate on any
 * thrown error. That retry-on-any-error behavior is unsafe for commands that
 * may have caused a side effect before the error was observed — a click,
 * submit, navigation, or upload can partially or fully complete, and replaying
 * it against a different target duplicates the effect with no way to undo it.
 *
 * This module makes dispatch capability-aware and side-effect safe:
 *
 * 1. **Typed failures** ({@link BrowserDispatchFailureKind}) replace opaque
 *    thrown errors so the dispatcher can decide whether fallback is legal.
 * 2. **Idempotency classification** ({@link isIdempotentBrowserSubaction})
 *    separates read-only commands from side-effecting commands so a
 *    post-dispatch failure can be typed accurately.
 *
 * Replay is forbidden for ALL subactions once execution begins — even
 * read-only ones. Registered targets are distinct browser sessions (the
 * embedded workspace vs. the user's real Chrome, Firefox, or Safari via the bridge), so
 * retrying a failed read against a different target would silently answer
 * from a different browser. The classification only controls error shape: a
 * failed read rethrows its original cause, while an opaquely failed mutation
 * is wrapped as `UNCERTAIN_OUTCOME`. The availability tradeoff is deliberate —
 * a transient read failure surfaces to the caller instead of being masked by
 * a cross-session fallback.
 */

import type { BrowserWorkspaceSubaction } from "./workspace/browser-workspace-types.js";

/**
 * The canonical typed failure kinds for a browser dispatch attempt.
 *
 * - `UNAVAILABLE` — no target was available to receive the command.
 * - `UNSUPPORTED` — the selected target does not support this subaction.
 * - `STALE_REF` — a snapshot element/tab reference is stale; re-snapshot and retry on the same session.
 * - `SESSION_GONE` — the browser session backing the target has ended.
 * - `AUTH_REQUIRED` — the command reached a page requiring authentication / manual handoff.
 * - `POLICY_BLOCKED` — a bridge/security policy declined the command.
 * - `UNCERTAIN_OUTCOME` — the command may have partially or fully completed before an error was observed; it must NOT be replayed.
 */
export const BROWSER_DISPATCH_FAILURE_KINDS = [
  "UNAVAILABLE",
  "UNSUPPORTED",
  "STALE_REF",
  "SESSION_GONE",
  "AUTH_REQUIRED",
  "POLICY_BLOCKED",
  "UNCERTAIN_OUTCOME",
] as const;

export type BrowserDispatchFailureKind =
  (typeof BROWSER_DISPATCH_FAILURE_KINDS)[number];

/**
 * A typed dispatch failure. Failures whose kind is `UNSUPPORTED` or
 * `UNAVAILABLE` are **pre-dispatch** — the command never began execution, so
 * fallback to another target is permitted. All other kinds are
 * **post-dispatch** and must never be replayed against another target (the
 * command may have caused a side effect).
 */
export class BrowserDispatchFailure extends Error {
  override readonly name = "BrowserDispatchFailure";
  readonly kind: BrowserDispatchFailureKind;
  /** The target id that produced (or would have received) the command. */
  readonly targetId: string | null;
  /** Whether fallback to another target is safe for this failure kind. */
  readonly fallbackSafe: boolean;

  constructor(
    kind: BrowserDispatchFailureKind,
    message: string,
    options?: { targetId?: string | null; cause?: unknown },
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.kind = kind;
    this.targetId = options?.targetId ?? null;
    this.fallbackSafe = kind === "UNSUPPORTED" || kind === "UNAVAILABLE";
    Object.setPrototypeOf(this, BrowserDispatchFailure.prototype);
  }
}

export function isBrowserDispatchFailure(
  value: unknown,
): value is BrowserDispatchFailure {
  return value instanceof BrowserDispatchFailure;
}

/**
 * Read-only subactions with no side effect on the page or session. Anything
 * not in this set is treated as potentially side-effecting (click, type,
 * navigate, open, submit, upload, etc.). Membership does not permit replay —
 * no subaction is replayed post-dispatch — it only determines how a
 * post-dispatch failure is typed.
 */
const IDEMPOTENT_SUBACTIONS: ReadonlySet<BrowserWorkspaceSubaction> = new Set([
  "list",
  "state",
  "get",
  "snapshot",
  "screenshot",
  "inspect",
  "console",
  "errors",
  "network",
  "diff",
]);

/**
 * Returns `true` when a subaction is read-only. The dispatcher uses this after
 * a post-dispatch failure to pick the error shape: read-only failures rethrow
 * the original cause, while opaque side-effecting failures (click, type, fill,
 * navigate, open, close, submit, upload, etc.) become `UNCERTAIN_OUTCOME`.
 * In neither case is the command replayed against another target.
 */
export function isIdempotentBrowserSubaction(
  subaction: BrowserWorkspaceSubaction,
): boolean {
  return IDEMPOTENT_SUBACTIONS.has(subaction);
}
