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
 * 2. **Capability manifests** ({@link BrowserTargetCapabilities}) let a target
 *    declare which subactions it supports *before* dispatch, so unsupported
 *    commands never reach `execute()`.
 * 3. **Idempotency classification** ({@link isIdempotentBrowserSubaction})
 *    separates safe-to-retry read-only commands from side-effecting commands
 *    that must never be replayed once execution begins.
 */

import type {
  BrowserWorkspaceCommand,
  BrowserWorkspaceSubaction,
} from "./workspace/browser-workspace-types.js";

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
 * Read-only subactions that are safe to retry across targets because they have
 * no side effect on the page or session. Anything not in this set is treated as
 * potentially side-effecting (click, type, navigate, open, submit, upload,
 * etc.) and is never replayed after execution has begun.
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
 * Returns `true` when a subaction is read-only and therefore safe to retry on a
 * different target. Side-effecting commands (click, type, fill, navigate, open,
 * close, submit, upload, drag, scroll, press, set, cookies, storage, etc.)
 * return `false` — once `execute()` has been called on any target the command
 * must not be dispatched to another.
 */
export function isIdempotentBrowserSubaction(
  subaction: BrowserWorkspaceSubaction,
): boolean {
  return IDEMPOTENT_SUBACTIONS.has(subaction);
}

/**
 * Capability manifest for a {@link CapabilityAwareBrowserTarget}. A target
 * returns this from {@link CapabilityAwareBrowserTarget.capabilities} to declare
 * which subactions it can execute *before* dispatch. The dispatcher uses it to
 * skip targets that cannot handle the command, returning `UNSUPPORTED` instead
 * of throwing.
 *
 * `subactions` is optional for backward compatibility — a target that does not
 * declare a manifest is assumed to support everything (legacy behavior).
 */
export interface BrowserTargetCapabilities {
  /**
   * Set of supported subaction strings. When omitted, the target claims support
   * for all subactions (legacy `workspace`-style target).
   */
  subactions?: ReadonlySet<string>;
}

/**
 * A target id (opaque session/profile/tab identity) plus the kind of action a
 * command represents, so a capability check can be done generically.
 */
export function classifySubactionSideEffects(
  command: BrowserWorkspaceCommand,
): "read" | "mutate" {
  return isIdempotentBrowserSubaction(command.subaction) ? "read" : "mutate";
}
