/**
 * Byte budget for a multipart upload, charged BEFORE the body is parsed.
 *
 * `Request.formData()` parses *and materializes* every part: by the time a
 * handler can ask `entry.size > MAX_BYTES`, the bytes it wants to refuse are
 * already resident. On a route whose declared cap is 5 MiB that is the whole
 * guard arriving after the whole cost, and the handler's `catch` cannot give a
 * completed allocation back — this package deploys as a Cloudflare Worker
 * (`packages/cloud/api/wrangler.toml`), where per-isolate memory is a hard
 * platform limit.
 *
 * `readRequestWithinMultipartBudget` puts the charge first, in the two stages
 * `packages/cloud/api/v1/voice/stt/route.ts` already uses for its own multipart
 * limit:
 *
 *  1. a declared `content-length` over budget is refused **without reading the
 *     body at all**, and the upload is cancelled best-effort;
 *  2. otherwise the body is streamed and each chunk is charged against the
 *     running total **before** it is retained, so peak retention is the budget
 *     plus the chunk in hand. A `content-length` that is absent, non-numeric,
 *     or not a safe integer is not treated as a budget grant.
 *
 * On success it returns a `Request` carrying the same URL, method and headers
 * (minus `content-length`, which no longer describes the buffered body) whose
 * body is the bytes that were charged, so the caller goes on to
 * `.formData()` exactly as before.
 *
 * Deliberately import-free so it can be driven on its own.
 */

export type BudgetedMultipartRequest =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly bytes: number };

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

function bufferedHeaders(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return headers;
}

/**
 * Reads `request`'s body under `maxBytes` and hands back an equivalent
 * `Request` to parse, or the size the refusal was made on.
 */
export async function readRequestWithinMultipartBudget(
  request: Request,
  maxBytes: number,
  onCancelFailure?: (label: string, error: unknown) => void,
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
    return { ok: false, bytes: declaredLength };
  }

  const headers = bufferedHeaders(request);

  if (!request.body) {
    const buffer = await request.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { ok: false, bytes: buffer.byteLength };
    }
    return {
      ok: true,
      request: new Request(request.url, {
        body: buffer,
        headers,
        method: request.method,
      }),
    };
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

  return {
    ok: true,
    request: new Request(request.url, {
      body,
      headers,
      method: request.method,
    }),
  };
}
