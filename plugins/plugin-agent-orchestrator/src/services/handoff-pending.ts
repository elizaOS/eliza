/**
 * In-process generation registry for the router's pending-handoff marker
 * (`routerHandoffPendingAt`). The router persists that marker on the ORIGINAL
 * session's metadata the moment it decides on a handoff (verify-retry or
 * failover respawn), BEFORE the successor spawn settles, so the swarm
 * coordinator can recognize the session's teardown `stopped` as handoff
 * plumbing. But a persisted marker can outlive its handoff — a crash between
 * stamp and settle, or a swallowed best-effort metadata clear, leaves it in
 * the store where it would suppress every later legitimate stop for that
 * session, forever.
 *
 * This registry scopes suppression to the handoff's generation: each decision
 * mints a unique token that is both written into the metadata marker and held
 * here while — and only while — the spawn is in flight. The coordinator
 * honors a marker only when its exact value is the current in-flight token;
 * any other persisted value (prior process, prior generation, already
 * settled) is stale and must be ignored and cleared. A process restart
 * empties the registry, which is exactly the wanted semantics: no handoff can
 * be in flight in a process that just booted.
 *
 * Router (writer) and coordinator (reader) run in the same runtime process,
 * so module state is the narrowest shared channel — no store schema, and no
 * import cycle between the two services.
 */

import { randomUUID } from "node:crypto";

const inFlightHandoffTokens = new Map<string, string>();

/**
 * Mint and register the current-generation token for a session's in-flight
 * handoff. The ISO prefix is traceability only; the whole value is the token.
 * Call BEFORE the successor spawn is awaited, and persist the returned value
 * as the metadata marker so reader and registry compare the same string.
 */
export function beginPendingHandoff(sessionId: string): string {
  const token = `${new Date().toISOString()}/${randomUUID()}`;
  inFlightHandoffTokens.set(sessionId, token);
  return token;
}

/**
 * Retire a generation token once its spawn settled (success or failure).
 * Token-matched so a stale settle can never retire a newer handoff's token.
 */
export function settlePendingHandoff(sessionId: string, token: string): void {
  if (inFlightHandoffTokens.get(sessionId) === token) {
    inFlightHandoffTokens.delete(sessionId);
  }
}

/**
 * True only while the marker value read from session metadata is the current
 * in-flight generation for that session. A persisted marker that fails this
 * check is stale and must not suppress a terminal.
 */
export function isPendingHandoffCurrent(
  sessionId: string,
  markerValue: string,
): boolean {
  return inFlightHandoffTokens.get(sessionId) === markerValue;
}
