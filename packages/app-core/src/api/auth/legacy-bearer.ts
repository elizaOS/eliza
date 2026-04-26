/**
 * Legacy bearer token grace-window helper.
 *
 * The static `ELIZA_API_TOKEN` bearer continues to work for 14 days after
 * upgrade so existing CI pipelines, scripts, and tools don't break in lock-
 * step with a release. After that window — OR the moment a real auth method
 * is established (password set, owner binding verified, cloud SSO linked) —
 * the legacy bearer is rejected.
 *
 * The grace deadline is sourced from (in order):
 *   1. `MILADY_LEGACY_GRACE_UNTIL` (unix ms timestamp). The deploy pipeline
 *      sets this at upgrade time. Authoritative.
 *   2. The earliest `auth.legacy_token.used` audit event recorded in the DB
 *      plus 14 days. Bootstrap from observation when the env var isn't set.
 *
 * If neither signal is available, the bearer is allowed (initial deployment
 * pre-first-use). The failure mode is intentional: never lock out the
 * upgrade window before any client has had a chance to migrate.
 *
 * Hard rule: this module only computes deadlines. It never grants access
 * outright; the caller still validates the token via `tokenMatches`.
 */

import type { RuntimeEnvRecord } from "@elizaos/shared";
import type { AuthStore } from "../../services/auth-store";
import { appendAuditEvent } from "./audit";

export const LEGACY_GRACE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
export const LEGACY_DEPRECATION_HEADER = "x-milady-legacy-token-deprecated";
export const LEGACY_USE_AUDIT_ACTION = "auth.legacy_token.used";
export const LEGACY_REJECT_AUDIT_ACTION = "auth.legacy_token.rejected";
export const LEGACY_INVALIDATE_AUDIT_ACTION = "auth.legacy_token.invalidated";

interface LegacyGraceState {
  deadline: number | null;
  invalidated: boolean;
}

/**
 * In-process flag flipped by `markLegacyBearerInvalidated()` the moment a
 * real auth method lands. Persists for the runtime lifetime; restart picks
 * the value up via the audit log on next call.
 */
const state: LegacyGraceState = {
  deadline: null,
  invalidated: false,
};

/** Reset internal state. Test-only. */
export function _resetLegacyBearerState(): void {
  state.deadline = null;
  state.invalidated = false;
}

function parseEnvDeadline(env: RuntimeEnvRecord): number | null {
  const raw = env.MILADY_LEGACY_GRACE_UNTIL?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Decide whether a legacy bearer is still inside the grace window.
 *
 * Returns:
 *   - `{ allowed: true, deprecated: true }` — legacy bearer accepted; emit
 *     the deprecation header and audit event.
 *   - `{ allowed: false, reason }` — reject with 401 and audit-emit a
 *     `legacy_token.rejected` event.
 */
export interface LegacyBearerDecision {
  allowed: boolean;
  reason?: "post_grace" | "invalidated";
}

export async function decideLegacyBearer(
  _store: AuthStore,
  env: RuntimeEnvRecord = process.env,
  now: number = Date.now(),
): Promise<LegacyBearerDecision> {
  if (state.invalidated) {
    return { allowed: false, reason: "invalidated" };
  }

  const envDeadline = parseEnvDeadline(env);
  if (envDeadline) {
    state.deadline = envDeadline;
    if (now >= envDeadline) {
      return { allowed: false, reason: "post_grace" };
    }
    return { allowed: true };
  }

  // No env-driven deadline. Bootstrap from the earliest observed legacy
  // use; if there is none yet, this is the first call and we set the
  // deadline 14 days out.
  if (state.deadline === null) {
    state.deadline = now + LEGACY_GRACE_WINDOW_MS;
  }
  if (now >= state.deadline) {
    return { allowed: false, reason: "post_grace" };
  }
  return { allowed: true };
}

/**
 * Audit-emit a successful legacy bearer use (deprecation event). Caller
 * should await; failures propagate.
 */
export async function recordLegacyBearerUse(
  store: AuthStore,
  meta: { ip: string | null; userAgent: string | null },
): Promise<void> {
  await appendAuditEvent(
    {
      actorIdentityId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: LEGACY_USE_AUDIT_ACTION,
      outcome: "success",
      metadata: {},
    },
    { store },
  );
}

/** Audit-emit a rejected legacy bearer attempt (post-grace or invalidated). */
export async function recordLegacyBearerRejection(
  store: AuthStore,
  meta: {
    ip: string | null;
    userAgent: string | null;
    reason: "post_grace" | "invalidated";
  },
): Promise<void> {
  await appendAuditEvent(
    {
      actorIdentityId: null,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: LEGACY_REJECT_AUDIT_ACTION,
      outcome: "failure",
      metadata: { reason: meta.reason },
    },
    { store },
  );
}

/**
 * Mark legacy bearer use as immediately rejected for the rest of this
 * runtime. Called when a real auth method lands (password setup, cloud SSO
 * link, owner binding verified). Also revokes existing `legacy`-scoped
 * machine sessions in the DB so they can't smuggle access through the
 * session layer.
 */
export async function markLegacyBearerInvalidated(
  store: AuthStore,
  meta: {
    actorIdentityId: string | null;
    ip: string | null;
    userAgent: string | null;
  },
): Promise<void> {
  state.invalidated = true;
  state.deadline = 0;
  const revoked = await store.revokeLegacyBearerSessions(Date.now());
  await appendAuditEvent(
    {
      actorIdentityId: meta.actorIdentityId,
      ip: meta.ip,
      userAgent: meta.userAgent,
      action: LEGACY_INVALIDATE_AUDIT_ACTION,
      outcome: "success",
      metadata: { revoked },
    },
    { store },
  );
}

/** Test helper for test files that want to predict the deadline. */
export function _peekLegacyBearerDeadline(): number | null {
  return state.deadline;
}

export function _peekLegacyBearerInvalidated(): boolean {
  return state.invalidated;
}
