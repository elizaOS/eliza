/**
 * Byte budget for a multipart upload, charged before the body is parsed.
 *
 * `Request.formData()` materializes every part, so a post-parse size check
 * cannot bound isolate memory. This helper refuses a trustworthy over-budget
 * `content-length` without reading; otherwise it streams into one `maxBytes`
 * slab and charges each chunk before retaining it. Peak residency is that
 * slab plus the chunk in hand, regardless of transport fragmentation.
 *
 * The Worker request `signal` and an owned deadline stop a body that never
 * completes. Reader-lock ownership is finally-based: success releases
 * immediately; overflow, abort, deadline, and read failure detach a no-throw
 * `cancel()` and release the lock only after cancellation settles.
 */

export type BudgetIncompleteReason =
  | "client-aborted"
  | "deadline"
  | "read-failed";

export type BudgetedMultipartRequest =
  | { readonly ok: true; readonly request: Request }
  | {
      readonly ok: false;
      readonly outcome: "oversized";
      readonly bytes: number;
    }
  | {
      readonly ok: false;
      readonly outcome: "incomplete";
      readonly reason: BudgetIncompleteReason;
      readonly error?: unknown;
    };

export interface MultipartBudgetReadOptions {
  /**
   * Owned wall-clock bound on the streamed read. A body that neither
   * completes nor errors within this window is abandoned rather than allowed
   * to pin the isolate.
   */
  readonly timeoutMs?: number;
}

/** Default wall-clock bound for one streamed multipart body read. */
export const MULTIPART_BODY_READ_DEADLINE_MS = 60_000;

type InterruptReason = "client-aborted" | "deadline";

/**
 * The declared body length, or `null` when the header is absent or is not a
 * plain decimal integer that survives `Number.isSafeInteger`.
 */
export function parseTrustworthyContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function reportCancelFailure(
  onCancelFailure: ((label: string, error: unknown) => void) | undefined,
  label: string,
  error: unknown,
): void {
  if (!onCancelFailure) return;
  try {
    onCancelFailure(label, error);
  } catch {
    // error-policy:J6 a throwing reporter must not escalate best-effort teardown.
  }
}

function cancelBestEffort(
  target: { cancel: () => Promise<unknown> },
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  const report = (error: unknown) =>
    reportCancelFailure(onCancelFailure, label, error);
  try {
    target.cancel().catch(report);
  } catch (error) {
    // error-policy:J6 best-effort teardown for an upload already rejected.
    report(error);
  }
}

/**
 * Detached no-throw teardown of a reader we are abandoning: cancellation runs
 * unobserved, failures go to the reporter, and the lock is released only once
 * cancellation has settled either way.
 */
function detachReaderWithCancel(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  const releaseAfterSettle = () => {
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 the runtime already tore the lock down; nothing to do.
    }
  };
  try {
    reader
      .cancel()
      .catch((error: unknown) =>
        reportCancelFailure(onCancelFailure, label, error),
      )
      .finally(releaseAfterSettle);
  } catch (error) {
    // error-policy:J6 best-effort teardown for an upload already rejected;
    // a synchronous cancel throw leaves nothing pending, so release now.
    reportCancelFailure(onCancelFailure, label, error);
    releaseAfterSettle();
  }
}

function bufferedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return headers;
}

function bufferedBody(
  slab: Uint8Array<ArrayBuffer> | undefined,
  received: number,
): Uint8Array<ArrayBuffer> {
  if (!slab || received === 0) return new Uint8Array(0);
  if (received === slab.byteLength) return slab;
  const body = new Uint8Array(received);
  body.set(slab.subarray(0, received));
  return body;
}

/**
 * Reads `request`'s body under `maxBytes` and hands back an equivalent
 * `Request` to parse, the size the refusal was made on, or why the body could
 * not be read to completion.
 */
export async function readRequestWithinMultipartBudget(
  request: Request,
  maxBytes: number,
  onCancelFailure?: (label: string, error: unknown) => void,
  options?: MultipartBudgetReadOptions,
): Promise<BudgetedMultipartRequest> {
  const declaredLength = parseTrustworthyContentLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (request.body) {
      cancelBestEffort(
        request.body,
        "content-length-precheck",
        onCancelFailure,
      );
    }
    return { ok: false, outcome: "oversized", bytes: declaredLength };
  }

  const headers = bufferedHeaders(request);
  const signal = request.signal;

  if (!request.body) {
    try {
      const buffer = await request.arrayBuffer();
      if (buffer.byteLength > maxBytes) {
        return { ok: false, outcome: "oversized", bytes: buffer.byteLength };
      }
      return {
        ok: true,
        request: new Request(request.url, {
          body: buffer,
          headers,
          method: request.method,
        }),
      };
    } catch (error) {
      // error-policy:J3 an unreadable body becomes an explicit invalid result.
      return {
        ok: false,
        outcome: "incomplete",
        reason: "read-failed",
        error,
      };
    }
  }

  if (signal.aborted) {
    cancelBestEffort(request.body, "client-aborted", onCancelFailure);
    return { ok: false, outcome: "incomplete", reason: "client-aborted" };
  }

  const reader = request.body.getReader();
  let detachedCancelOwnsRelease = false;

  try {
    let fireInterrupt: ((reason: InterruptReason) => void) | undefined;
    const interrupted = new Promise<InterruptReason>((resolve) => {
      fireInterrupt = resolve;
    });
    const onAbort = () => fireInterrupt?.("client-aborted");
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      fireInterrupt?.("client-aborted");
    }
    const timer = setTimeout(
      () => fireInterrupt?.("deadline"),
      options?.timeoutMs ?? MULTIPART_BODY_READ_DEADLINE_MS,
    );

    try {
      let received = 0;
      // One bounded slab, allocated only after the first in-budget chunk is
      // charged. Hostile one-byte streams still occupy this single object.
      let slab: Uint8Array<ArrayBuffer> | undefined;

      while (true) {
        const pendingRead = reader.read();
        // error-policy:J5 the same pending read is observed by Promise.race;
        // a late rejection after interrupt/cancel must not become unhandled.
        void pendingRead.then(
          () => undefined,
          () => undefined,
        );
        const raced = await Promise.race([pendingRead, interrupted]);
        if (raced === "client-aborted" || raced === "deadline") {
          detachedCancelOwnsRelease = true;
          detachReaderWithCancel(reader, "stream-interrupted", onCancelFailure);
          return { ok: false, outcome: "incomplete", reason: raced };
        }
        const { done, value } = raced;
        if (done) {
          return {
            ok: true,
            request: new Request(request.url, {
              body: bufferedBody(slab, received),
              headers,
              method: request.method,
            }),
          };
        }
        if (!value || value.byteLength === 0) continue;

        const chunkSize = value.byteLength;
        // Charge before retention: an over-budget chunk is not copied and
        // never causes the slab to be allocated.
        if (chunkSize > maxBytes - received) {
          detachedCancelOwnsRelease = true;
          detachReaderWithCancel(reader, "streamed-budget", onCancelFailure);
          return {
            ok: false,
            outcome: "oversized",
            bytes: received + chunkSize,
          };
        }
        slab ??= new Uint8Array(maxBytes);
        slab.set(value, received);
        received += chunkSize;
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  } catch (error) {
    // error-policy:J3 an unreadable stream becomes an explicit invalid result,
    // never a fake-valid body, and the route boundary reports it.
    detachedCancelOwnsRelease = true;
    detachReaderWithCancel(reader, "read-failure", onCancelFailure);
    return {
      ok: false,
      outcome: "incomplete",
      reason: "read-failed",
      error,
    };
  } finally {
    if (!detachedCancelOwnsRelease) {
      try {
        reader.releaseLock();
      } catch {
        // error-policy:J6 the lock was already torn down with the reader; nothing to do.
      }
    }
  }
}
