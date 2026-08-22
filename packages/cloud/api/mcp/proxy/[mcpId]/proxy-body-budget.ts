/**
 * Byte budgets for the two bodies the MCP proxy buffers into the isolate.
 *
 * `route.ts` reads the caller's request body with `await request.text()` and
 * the MCP server's response with `await mcpResponse.text()`. Neither read has
 * a byte budget, and for the response the far end is a URL the MCP's owner
 * chose (`external_endpoint`, reached through `safeFetch`) — so the number of
 * bytes an isolate spends on one proxied call is picked by whoever registered
 * the MCP, not by this service.
 *
 * This package deploys as a Cloudflare Worker
 * (`packages/cloud/api/wrangler.toml`, `name = "eliza-cloud-api"`), where
 * per-isolate memory is a hard platform limit. The handler's `catch` around
 * each read is real, but it catches read *failures*; it cannot give back an
 * allocation that has already completed.
 *
 * The reader below charges the budget BEFORE the bytes are retained, in the
 * two stages this repository already uses in
 * `@/lib/services/oauth/credential-broker.ts` (#23900),
 * `api/v1/voice/stt/route.ts`, and `api/scripts/local-voice-runtime-identity.ts`:
 *
 *  1. a declared `content-length` over budget is refused without reading the
 *     body at all;
 *  2. otherwise the body is streamed, each chunk charged against the running
 *     total before it is retained, and cut off the moment the total passes the
 *     budget. Bytes are copied into one fixed-size slab and decoded once, so
 *     retained chunk objects cannot multiply isolate memory independently of
 *     the byte budget.
 *
 * Deliberately import-free so it can be driven on its own.
 */

/** The subset of `Request` / `Response` this reader needs. */
export interface BudgetedBodySource {
  readonly headers: Headers;
  readonly body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type BudgetedText =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly bytes: number;
      readonly reason: "byte-budget" | "fragmentation-budget";
    };

/**
 * Limit pull/decoder churn independently from payload bytes. A standard
 * transport should coalesce far below this count; rejecting a deliberately
 * one-byte-at-a-time stream prevents millions of isolate allocations/callbacks.
 */
const MAX_BODY_STREAM_CHUNKS = 8_192;

/**
 * The declared body length, or `null` when the header is absent or is not a
 * plain decimal integer that survives `Number.isSafeInteger`. A header that
 * cannot be trusted is not treated as a budget grant — such a body falls
 * through to the streamed charge below.
 */
export function parseTrustworthyContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
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
    // error-policy:J6 best-effort teardown for a body already rejected.
    report(error);
  }
}

/**
 * Reads `source`'s body as text, refusing it as soon as `maxBytes` is exceeded.
 *
 * On refusal `bytes` is the size the refusal was made on: the declared
 * `content-length` when the pre-check fired, otherwise the running total at the
 * chunk that exceeded the byte or fragmentation budget (a lower bound on the
 * real size — the rest is never read).
 */
export async function readBodyTextWithinBudget(
  source: BudgetedBodySource,
  maxBytes: number,
  onCancelFailure?: (label: string, error: unknown) => void,
): Promise<BudgetedText> {
  const declaredLength = parseTrustworthyContentLength(source.headers);
  if (declaredLength !== null && declaredLength > maxBytes) {
    if (source.body) {
      cancelBestEffort(source.body, "content-length-precheck", onCancelFailure);
    }
    return { ok: false, bytes: declaredLength, reason: "byte-budget" };
  }

  if (!source.body) {
    const text = await source.text();
    return { ok: true, text };
  }

  const reader = source.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const retained = new Uint8Array(maxBytes);
  let received = 0;
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      chunkCount += 1;
      received += value.byteLength;
      if (received > maxBytes) {
        cancelBestEffort(reader, "streamed-budget", onCancelFailure);
        return { ok: false, bytes: received, reason: "byte-budget" };
      }
      if (chunkCount > MAX_BODY_STREAM_CHUNKS) {
        cancelBestEffort(reader, "streamed-fragmentation", onCancelFailure);
        return {
          ok: false,
          bytes: received,
          reason: "fragmentation-budget",
        };
      }
      retained.set(value, received - value.byteLength);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      // error-policy:J6 The body read has already reached a terminal result;
      // releasing the reader is best-effort transport teardown.
      onCancelFailure?.("reader-release", error);
    }
  }

  return { ok: true, text: decoder.decode(retained.subarray(0, received)) };
}
