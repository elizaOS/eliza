/**
 * Byte budget for the raw-body PUT on `/api/v1/apis/storage/objects/_`.
 *
 * `route.ts` has always advertised `MAX_PUT_BYTES`, but the check ran only
 * after `c.req.arrayBuffer()` had already materialized the whole request body
 * inside the isolate. This package deploys as a Cloudflare Worker
 * (`packages/cloud/api/wrangler.toml`), where per-isolate memory is a hard
 * platform limit, so the bytes were spent in full before the guard that exists
 * to refuse them could look at them — and the handler's `catch` cannot give a
 * completed allocation back.
 *
 * This reader charges the budget BEFORE the bytes are retained, in the two
 * stages the rest of the package already uses (`v1/voice/stt/route.ts`,
 * `scripts/local-voice-runtime-identity.ts`,
 * `@/lib/services/oauth/credential-broker.ts`):
 *
 *  1. a declared `content-length` over budget is refused without reading the
 *     body at all — a client that announces its size never gets a byte
 *     allocated;
 *  2. a body with no `content-length`, or a lying one, is charged chunk by
 *     chunk and cut off the moment the running total passes the budget, so the
 *     peak retained is one chunk past the budget rather than whatever the
 *     client chose to send.
 *
 * Deliberately import-free so it can be driven on its own.
 */

export type BudgetedRequestBody =
  | { readonly ok: true; readonly body: ArrayBuffer }
  | { readonly ok: false; readonly bytes: number };

/**
 * The declared body length, or `null` when the header is absent or is not a
 * plain decimal integer that survives `Number.isSafeInteger`. A header that
 * cannot be trusted is not treated as a budget grant — such a body falls
 * through to the streamed charge below.
 */
export function parseTrustworthyContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (!raw) return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cancelBestEffort(
  target: { cancel: () => Promise<unknown> },
  label: string,
  onCancelFailure?: (label: string, error: unknown) => void,
): void {
  const report = (error: unknown) => onCancelFailure?.(label, error);
  try {
    target.cancel().catch(report);
  } catch (error) {
    // error-policy:J6 best-effort teardown for an upload already rejected.
    report(error);
  }
}

/**
 * Reads `request`'s body, refusing it as soon as `maxBytes` is exceeded.
 *
 * On refusal `bytes` is the size the refusal was made on: the declared
 * `content-length` when the pre-check fired, otherwise the running total at
 * the chunk that blew the budget (which is a lower bound on the real size, not
 * the real size — the rest is never read).
 */
export async function readRequestBodyWithinBudget(
  request: Request,
  maxBytes: number,
  onCancelFailure?: (label: string, error: unknown) => void,
): Promise<BudgetedRequestBody> {
  const declaredLength = parseTrustworthyContentLength(request);
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (request.body) {
      cancelBestEffort(request.body, "content-length-precheck", onCancelFailure);
    }
    return { ok: false, bytes: declaredLength };
  }

  if (!request.body) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { ok: false, bytes: buffer.byteLength };
    }
    return { ok: true, body: buffer };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      cancelBestEffort(reader, "streamed-budget", onCancelFailure);
      return { ok: false, bytes: received };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: body.buffer as ArrayBuffer };
}
