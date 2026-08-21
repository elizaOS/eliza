/**
 * Owns the byte budget for every social media attachment a provider hands to
 * an authenticated upload API.
 *
 * URL-backed attachments go through the shared outbound network guard with a
 * hard streaming byte limit. Attachments the caller supplied inline — the
 * `media.data` and `media.base64` siblings of the same provider `if/else` —
 * are charged against that same budget here, so no provider branch can
 * allocate unbounded bytes inside the Worker isolate.
 *
 * The budget is a parameter, not a constant, because TikTok chunk-uploads
 * video: the image ceiling would reject ordinary video posts, but the decode
 * still happens in one allocation, so it takes the larger
 * `SOCIAL_MEDIA_VIDEO_MAX_BYTES` rather than no bound at all.
 */
import { ElizaError } from "@elizaos/core";

import { safeFetch } from "../../security/safe-fetch";
import {
  SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH,
  SOCIAL_MEDIA_MEDIA_MAX_BYTES,
} from "../../types/social-media";

const SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;

interface SocialMediaDownloadOptions {
  httpErrorMessage?: (status: number) => string;
  signal?: AbortSignal;
}

function downloadError(
  message: string,
  code: string,
  context: Record<string, unknown>,
  cause?: unknown,
): ElizaError {
  return new ElizaError(message, {
    code,
    context,
    severity: "ephemeral",
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Charges the shared media byte budget against bytes a provider is about to
 * hand to an upload API. Fails closed with the same typed error the URL branch
 * raises, so an oversized attachment is rejected identically on every branch.
 */
export function assertSocialMediaBytesWithinBudget(
  byteLength: number,
  context: Record<string, unknown> = {},
  maxBytes: number = SOCIAL_MEDIA_MEDIA_MAX_BYTES,
): void {
  if (byteLength <= maxBytes) return;
  throw downloadError(
    "Media attachment exceeds the media byte limit",
    "SOCIAL_MEDIA_MEDIA_TOO_LARGE",
    { receivedBytes: byteLength, maxBytes, ...context },
  );
}

/**
 * Decodes a caller-supplied base64 attachment under the budget the URL branch
 * already enforces.
 *
 * The budget is a DECODED-byte budget, charged twice. First against the
 * encoded character count, so an oversized payload is rejected BEFORE
 * `Buffer.from` allocates the decode; every payload the URL branch accepts
 * (at most {@link SOCIAL_MEDIA_MEDIA_MAX_BYTES} bytes) encodes to at most
 * {@link SOCIAL_MEDIA_MEDIA_MAX_BASE64_LENGTH} characters, so nothing that
 * posts today is rejected by that pre-check. Then against the buffer actually
 * produced, because `Buffer.from` skips characters outside the base64 alphabet
 * and a padded string of the maximum accepted length can still decode two
 * bytes past the budget.
 */
export function decodeSocialMediaBase64(
  base64: string,
  context: Record<string, unknown> = {},
  maxBytes: number = SOCIAL_MEDIA_MEDIA_MAX_BYTES,
): Buffer {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (base64.length > maxEncodedLength) {
    throw downloadError(
      "Media attachment exceeds the media byte limit",
      "SOCIAL_MEDIA_MEDIA_TOO_LARGE",
      {
        encodedLength: base64.length,
        maxEncodedLength,
        maxBytes,
        ...context,
      },
    );
  }

  const bytes = Buffer.from(base64, "base64");
  assertSocialMediaBytesWithinBudget(bytes.length, context, maxBytes);
  return bytes;
}

function cancelBody(response: Response, reason?: unknown): void {
  try {
    void response.body?.cancel(reason).catch(() => {
      // error-policy:J6 The authoritative download failure is already known;
      // response cancellation is best-effort connection teardown.
    });
  } catch {
    // error-policy:J6 The authoritative download failure is already known;
    // synchronous response cancellation is best-effort connection teardown.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => {
      // error-policy:J6 The authoritative download failure is already known;
      // reader cancellation is best-effort connection teardown.
    });
  } catch {
    // error-policy:J6 Synchronous reader cancellation is best-effort teardown.
  }
}

async function readBodyWithLimit(response: Response, signal: AbortSignal): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  const declaredLength = rawLength === null ? null : Number(rawLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > SOCIAL_MEDIA_MEDIA_MAX_BYTES
  ) {
    cancelBody(response);
    throw downloadError(
      "Remote media exceeds the download byte limit",
      "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
      { declaredBytes: declaredLength, maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES },
    );
  }

  const body = response.body;
  if (!body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > SOCIAL_MEDIA_MEDIA_MAX_BYTES) {
      throw downloadError(
        "Remote media exceeds the download byte limit",
        "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
        { receivedBytes: bytes.length, maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES },
      );
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    cancelReader(reader, signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();

  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > SOCIAL_MEDIA_MEDIA_MAX_BYTES) {
        cancelReader(reader);
        throw downloadError(
          "Remote media exceeds the download byte limit",
          "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
          { receivedBytes: total, maxBytes: SOCIAL_MEDIA_MEDIA_MAX_BYTES },
        );
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // error-policy:J6 Stream lock release is best-effort teardown.
    }
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
}

/** Downloads one untrusted media URL under the social-provider network policy. */
export async function downloadSocialMediaBytes(
  sourceUrl: string,
  options: SocialMediaDownloadOptions = {},
): Promise<Buffer> {
  const controller = new AbortController();
  const timeoutError = downloadError(
    `Remote media download timed out after ${SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS}ms`,
    "SOCIAL_MEDIA_DOWNLOAD_TIMEOUT",
    { timeoutMs: SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS },
  );
  let rejectDeadline: (reason: unknown) => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = (reason: unknown): void => {
    controller.abort(reason);
    rejectDeadline(reason);
  };
  const onCallerAbort = (): void => abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  if (options.signal?.aborted) onCallerAbort();

  const timeout = setTimeout(() => abort(timeoutError), SOCIAL_MEDIA_DOWNLOAD_TIMEOUT_MS);
  timeout.unref?.();

  try {
    const response = await Promise.race([
      safeFetch(sourceUrl, { signal: controller.signal }),
      deadline,
    ]);
    if (!response.ok) {
      cancelBody(response);
      const message =
        options.httpErrorMessage?.(response.status) ?? `Media fetch failed: ${response.status}`;
      throw downloadError(message, "SOCIAL_MEDIA_DOWNLOAD_HTTP_ERROR", {
        status: response.status,
      });
    }
    return await Promise.race([readBodyWithLimit(response, controller.signal), deadline]);
  } catch (error) {
    if (error === options.signal?.reason || error === timeoutError || error instanceof ElizaError) {
      throw error;
    }
    // error-policy:J2 Preserve the outbound guard or transport failure as the cause.
    throw downloadError("Remote media download failed", "SOCIAL_MEDIA_DOWNLOAD_FAILED", {}, error);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
