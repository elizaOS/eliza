/**
 * Trusted length headers and best-effort body teardown for storage object PUT.
 *
 * The route streams the request body to R2 and must not materialize it in the
 * isolate. `Number(header)` is not a budget grant: scientific, hex, signed, and
 * padded-non-decimal forms would reserve the wrong size (or a huge one) before
 * the stream is handed off. A header that is not a plain safe decimal is
 * refused, and the unread body is cancelled without taking a reader lock on the
 * success path.
 *
 * Cancellation is detached from the HTTP response: a `cancel()` that never
 * settles must not hang the 411/400, and `releaseLock` (when the target is a
 * reader) runs only after cancel settles. Deliberately import-free so the
 * helper can be driven on its own.
 */

/**
 * A stream or reader that can be cancelled. Readers also expose `releaseLock`;
 * streams do not. Release is sequenced after cancel so a detached cancel cannot
 * race ownership.
 */
export type CancelableReadSource = {
  cancel: (reason?: unknown) => Promise<unknown>;
  releaseLock?: () => void;
};

/**
 * A plain non-negative decimal integer that survives `Number.isSafeInteger`,
 * or `null` when `raw` is absent or not trustworthy. Trimmed ASCII digits only;
 * `Number("1e3")` / `Number("0x10")` / `Number("+7")` are not grants.
 */
export function parseTrustworthyDecimalInteger(
  raw: string | null | undefined,
): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * The declared `Content-Length`, or `null` when the header is absent or is not
 * a plain safe decimal integer.
 */
export function parseTrustworthyContentLength(request: Request): number | null {
  return parseTrustworthyDecimalInteger(request.headers.get("content-length"));
}

function releaseLockAfterCancel(target: CancelableReadSource): void {
  if (typeof target.releaseLock !== "function") return;
  try {
    target.releaseLock();
  } catch {
    // error-policy:J6 lock may already be released after cancel settles.
  }
}

/**
 * Detached, no-throw cancel. The caller must not await this: a cancel that
 * never settles still has to let the 411/400 return. `releaseLock` (if present)
 * runs only after cancel settles, or immediately after a synchronous throw.
 */
export function cancelBestEffort(
  target: CancelableReadSource,
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  const report = (error: unknown) => onCancelFailure?.(label, error);
  try {
    const cancellation = target.cancel();
    void Promise.resolve(cancellation)
      .catch((error) => {
        // error-policy:J6 best-effort teardown for an upload already rejected.
        report(error);
      })
      .finally(() => {
        releaseLockAfterCancel(target);
      });
  } catch (error) {
    // error-policy:J6 synchronous cancel is teardown-only.
    report(error);
    releaseLockAfterCancel(target);
  }
}
