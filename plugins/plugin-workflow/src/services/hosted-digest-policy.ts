/**
 * Occurrence policy of scheduled digests (resident briefs), shared by the
 * agent's admission (`hosted-digest.ts`) and every client that presents or
 * mirrors it. Browser-safe: no Node, database or runtime imports.
 *
 * Schedules run only while the phone (and so the resident agent) is powered
 * on. The durable runtime scheduler (TaskService triggers) fires an occurrence
 * that came due while the agent was not running once, at startup; admission
 * then records it once as `missed` and never runs it late. The trigger re-arms
 * from the current time, so a long absence leaves one record and no backlog.
 */

/** An occurrence admitted more than this long after its scheduled time is missed. */
export const DIGEST_RUN_WINDOW_MS = 120_000;

/** Occurrences the agent records without running them. They are records, not briefs. */
export const DIGEST_NOT_RUN_STATUSES = ['missed', 'overlap', 'unavailable'] as const;
export type DigestNotRunStatus = (typeof DIGEST_NOT_RUN_STATUSES)[number];

export const DIGEST_MISSED_TEXT = 'The scheduled time was missed. No backlog was executed.';
export const DIGEST_OVERLAP_TEXT =
  'An earlier occurrence is still active. This occurrence did not run.';
/** A lapsed source pauses its schedule instead of producing one failure brief per day. */
export const DIGEST_PAUSED_TEXT: Readonly<Record<'expired' | 'revoked', string>> = Object.freeze({
  expired:
    'Source expired. This schedule is paused until you renew the source. No fresh phone data was read.',
  revoked:
    'Source revoked. This schedule is paused until you review a new source. No fresh phone data was read.',
});
export const DIGEST_SOURCE_UNAVAILABLE_TEXT =
  'The reviewed source is revoked or expired. No fresh phone data was read.';

/** True for a status the agent records without running the occurrence. */
export function isDigestNotRunStatus(status: unknown): status is DigestNotRunStatus {
  return (
    typeof status === 'string' && (DIGEST_NOT_RUN_STATUSES as readonly string[]).includes(status)
  );
}

/** Revocation wins; a source expires at its expiry instant. */
export function digestSourceState(
  source: { revoked: boolean; expiresAt: string },
  now = Date.now()
): 'current' | 'expired' | 'revoked' {
  if (source.revoked) return 'revoked';
  return Date.parse(source.expiresAt) <= now ? 'expired' : 'current';
}

/** True when an occurrence admitted at `now` is outside its run window. */
export function digestOccurrenceMissed(scheduledAt: number, now: number): boolean {
  return now - scheduledAt > DIGEST_RUN_WINDOW_MS;
}
