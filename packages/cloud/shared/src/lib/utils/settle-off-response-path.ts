/**
 * Run a post-response billing/settlement task OFF the response hot path (#8759).
 *
 * On a Cloudflare Worker, `executionCtx.waitUntil` keeps the request alive for
 * the writes (billUsage → settleReservation → reconcile → analytics → audit)
 * WITHOUT blocking the bytes returned to the client — that ~7-11s/turn chain was
 * previously awaited inline on the response path. Without an `executionCtx`
 * (tests, non-Worker callers) the task runs inline so behavior is identical.
 *
 * The caller owns error handling INSIDE `task` (e.g. settleReservation(0) on a
 * billUsage failure); this helper only decides defer-vs-inline.
 */
export function settleOffResponsePath(
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
  task: () => Promise<void>,
): Promise<void> {
  if (typeof executionCtx?.waitUntil === "function") {
    executionCtx.waitUntil(task());
    return Promise.resolve();
  }
  return task();
}
