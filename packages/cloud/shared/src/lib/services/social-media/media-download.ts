/**
 * Downloads URL-backed social media attachments through the shared outbound
 * network guard and enforces a hard streaming byte limit before providers
 * hand the bytes to their authenticated upload APIs.
 */
import { ElizaError } from "@elizaos/core";

import { safeFetch } from "../../security/safe-fetch";

const SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
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

async function cancelBody(response: Response, reason?: unknown): Promise<void> {
  try {
    await response.body?.cancel(reason);
  } catch {
    // error-policy:J6 The authoritative download failure is already known;
    // response cancellation is best-effort connection teardown.
  }
}

async function readBodyWithLimit(response: Response, signal: AbortSignal): Promise<Buffer> {
  const rawLength = response.headers.get("content-length");
  const declaredLength = rawLength === null ? null : Number(rawLength);
  if (
    declaredLength !== null &&
    Number.isFinite(declaredLength) &&
    declaredLength > SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES
  ) {
    await cancelBody(response);
    throw downloadError(
      "Remote media exceeds the download byte limit",
      "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
      { declaredBytes: declaredLength, maxBytes: SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES },
    );
  }

  const body = response.body;
  if (!body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES) {
      throw downloadError(
        "Remote media exceeds the download byte limit",
        "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
        { receivedBytes: bytes.length, maxBytes: SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES },
      );
    }
    return bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel(signal.reason).catch(() => {
      // error-policy:J6 The abort reason remains authoritative; reader
      // cancellation is best-effort connection teardown.
    });
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
      if (total > SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // error-policy:J6 The byte-limit failure is authoritative; reader
          // cancellation is best-effort connection teardown.
        }
        throw downloadError(
          "Remote media exceeds the download byte limit",
          "SOCIAL_MEDIA_DOWNLOAD_TOO_LARGE",
          { receivedBytes: total, maxBytes: SOCIAL_MEDIA_DOWNLOAD_MAX_BYTES },
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
      await cancelBody(response);
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
