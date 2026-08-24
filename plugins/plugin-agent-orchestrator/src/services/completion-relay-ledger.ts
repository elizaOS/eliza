/**
 * Durable ledger for user-facing completion relays.
 *
 * The router's completion relay (the "your build is done, here's the link"
 * post to the origin room) used to live only in process memory: the deferred
 * relay map, the delivered-dedup set, and the release timers all die with the
 * process. A restart landing between a sub-agent's `task_complete` and the
 * origin-room post silently swallowed the completion — the app deployed but
 * the room never heard (live 2026-08-21 Daily Hue, second occurrence of the
 * restart-loss class).
 *
 * This module defines the durable shape stamped onto the orchestrator task
 * record's metadata bag:
 *
 *  - `pendingCompletionRelays` — a per-session map of completion payloads the
 *    router has accepted but not yet confirmed delivered. Stamped when the
 *    relay is deferred for verification AND immediately before an undeferred
 *    emit, so every in-flight relay survives a restart.
 *  - `deliveredCompletionRelayKeys` — request-voice keys (or per-session
 *    fallback keys) whose relay HAS been posted. Stamped only AFTER a
 *    successful emit — stamping before the emit would record a delivery that
 *    never happened, which is exactly the loss class this ledger exists to
 *    close. The list is exhaustive per task (no item ceiling): a task has at
 *    most a handful of sessions, and a truncated ledger would re-emit
 *    delivered relays.
 *
 * On start the router sweeps tasks whose ledger still holds a pending entry
 * (see SubAgentRouter.sweepUndeliveredCompletionRelays) and re-emits the
 * relay with an honest "finished while I was restarting" note. Delivery is
 * therefore at-least-once: a crash inside the emit window can duplicate a
 * relay, but never lose one.
 *
 * @module services/completion-relay-ledger
 */

/** Task-metadata key holding the per-session pending relay map. */
export const PENDING_COMPLETION_RELAYS_METADATA_KEY = "pendingCompletionRelays";

/** Task-metadata key holding the delivered request-key ledger. */
export const DELIVERED_COMPLETION_RELAYS_METADATA_KEY =
  "deliveredCompletionRelayKeys";

/** Marker key the restart sweep sets on the re-emitted completion payload so
 *  the narration composer can tell the user honestly that the result was
 *  recovered across a restart instead of pretending it just finished. */
export const RESTART_RECOVERED_RELAY_DATA_KEY = "restartRecoveredRelay";

/** Serializable snapshot of the ACP session, captured at stamp time, complete
 * enough for the router to rebuild a `SessionInfo` and re-drive the relay
 * even when the ACP session store no longer holds the row after a restart.
 * Dates are ISO strings (the metadata bag must round-trip through JSON). */
export interface PendingRelaySessionSnapshot {
  id: string;
  agentType: string;
  workdir: string;
  status: string;
  approvalPreset: string;
  createdAt: string;
  lastActivityAt: string;
  metadata?: Record<string, unknown>;
}

/** One undelivered completion relay, durably stamped on the task record. */
export interface PendingCompletionRelay {
  sessionId: string;
  /** Request-voice key for cross-restart dedupe; null when the origin carries
   *  no stable per-request id (dedupe then falls back to the session id). */
  requestKey: string | null;
  /** Epoch ms when the relay was stamped pending. */
  stampedAt: number;
  /** The COMPLETE task_complete payload — the relay re-emits exactly what the
   *  sub-agent reported, never a summary of it. */
  data: Record<string, unknown>;
  turnId?: string;
  session: PendingRelaySessionSnapshot;
}

/** The dedupe key a relay is delivered under: the stable request-voice key
 * when one exists, else a per-session fallback so dedupe never collapses two
 * unrelated sessions that both lack request identity. */
export function completionRelayDedupeKey(
  requestKey: string | null | undefined,
  sessionId: string,
): string {
  return requestKey && requestKey.length > 0
    ? requestKey
    : `session:${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the pending map off a task-metadata bag. Malformed entries are
 * dropped structurally (a corrupt entry cannot be re-emitted anyway); a
 * missing/invalid bag reads as empty. */
export function readPendingCompletionRelays(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, PendingCompletionRelay> {
  const raw = metadata?.[PENDING_COMPLETION_RELAYS_METADATA_KEY];
  if (!isRecord(raw)) return {};
  const out: Record<string, PendingCompletionRelay> = {};
  for (const [sessionId, entry] of Object.entries(raw)) {
    if (!isRecord(entry)) continue;
    const snapshot = entry.session;
    if (!isRecord(snapshot)) continue;
    if (typeof entry.sessionId !== "string" || entry.sessionId.length === 0) {
      continue;
    }
    if (!isRecord(entry.data)) continue;
    if (
      typeof snapshot.id !== "string" ||
      typeof snapshot.agentType !== "string" ||
      typeof snapshot.workdir !== "string"
    ) {
      continue;
    }
    out[sessionId] = entry as unknown as PendingCompletionRelay;
  }
  return out;
}

/** Read the delivered dedupe-key ledger off a task-metadata bag. */
export function readDeliveredCompletionRelayKeys(
  metadata: Record<string, unknown> | null | undefined,
): string[] {
  const raw = metadata?.[DELIVERED_COMPLETION_RELAYS_METADATA_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (key): key is string => typeof key === "string" && key.length > 0,
  );
}

/** New metadata bag with `entry` stamped pending (keyed by its sessionId).
 * Re-stamping the same session replaces its entry — a verify-retry lap's
 * fresh completion supersedes the previous payload. */
export function withPendingCompletionRelay(
  metadata: Record<string, unknown> | null | undefined,
  entry: PendingCompletionRelay,
): Record<string, unknown> {
  const pending = readPendingCompletionRelays(metadata);
  return {
    ...(metadata ?? {}),
    [PENDING_COMPLETION_RELAYS_METADATA_KEY]: {
      ...pending,
      [entry.sessionId]: entry,
    },
  };
}

/** New metadata bag with the session's pending entry removed. Removing the
 * last entry removes the map key entirely so untouched tasks keep a clean
 * metadata bag. */
export function withoutPendingCompletionRelay(
  metadata: Record<string, unknown> | null | undefined,
  sessionId: string,
): Record<string, unknown> {
  const pending = readPendingCompletionRelays(metadata);
  const { [sessionId]: _removed, ...rest } = pending;
  const next = { ...(metadata ?? {}) };
  if (Object.keys(rest).length > 0) {
    next[PENDING_COMPLETION_RELAYS_METADATA_KEY] = rest;
  } else {
    delete next[PENDING_COMPLETION_RELAYS_METADATA_KEY];
  }
  return next;
}

/** New metadata bag with `dedupeKey` appended to the delivered ledger (and
 * the session's pending entry cleared). Idempotent on the key. */
export function withDeliveredCompletionRelay(
  metadata: Record<string, unknown> | null | undefined,
  sessionId: string,
  dedupeKey: string,
): Record<string, unknown> {
  const cleared = withoutPendingCompletionRelay(metadata, sessionId);
  const delivered = readDeliveredCompletionRelayKeys(cleared);
  return {
    ...cleared,
    [DELIVERED_COMPLETION_RELAYS_METADATA_KEY]: delivered.includes(dedupeKey)
      ? delivered
      : [...delivered, dedupeKey],
  };
}
