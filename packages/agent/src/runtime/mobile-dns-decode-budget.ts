/**
 * Decodes compressed responses for the mobile DNS-pinned fetch wrapper while
 * enforcing a byte budget before chunks enter the web Response stream.
 */

import { type Readable, Transform } from "node:stream";
import zlib from "node:zlib";
import { ElizaError } from "@elizaos/core";

export const MAX_MOBILE_DNS_DECODED_BYTES = 64 * 1024 * 1024;

export class MobileFetchDecodeBudgetError extends ElizaError {
  override readonly name = "MobileFetchDecodeBudgetError";

  constructor(
    readonly decodedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `mobile DNS fetch decoded body exceeded ${maxBytes} bytes (got ${decodedBytes})`,
      {
        code: "MOBILE_FETCH_DECODE_TOO_LARGE",
        context: { decodedBytes, maxBytes },
      },
    );
  }
}

/** Credit one decoded chunk; throw before the caller enqueues past the cap. */
export function creditDecodedBodyBytes(
  state: { bytes: number },
  chunkLength: number,
  maxBytes = MAX_MOBILE_DNS_DECODED_BYTES,
): void {
  state.bytes += chunkLength;
  if (state.bytes > maxBytes) {
    throw new MobileFetchDecodeBudgetError(state.bytes, maxBytes);
  }
}

/** Decode a supported content encoding and fail the stream above its budget. */
export function decodeMobileFetchBody(
  source: Readable,
  contentEncoding: string,
  maxBytes = MAX_MOBILE_DNS_DECODED_BYTES,
): Readable {
  const decoded =
    contentEncoding === "gzip"
      ? source.pipe(zlib.createGunzip())
      : contentEncoding === "deflate"
        ? source.pipe(zlib.createInflate())
        : contentEncoding === "br"
          ? source.pipe(zlib.createBrotliDecompress())
          : source;
  if (decoded === source) return source;

  const state = { bytes: 0 };
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        creditDecodedBodyBytes(state, chunk.length, maxBytes);
        callback(null, chunk);
      } catch (error) {
        // error-policy:J1 translate synchronous rejection to a stream failure.
        callback(
          error instanceof Error
            ? error
            : new ElizaError("mobile DNS decode budget failed", {
                code: "MOBILE_FETCH_DECODE_FAILED",
                cause: error,
              }),
        );
      }
    },
  });

  // Node's pipe does not forward source errors or tear down upstream streams.
  decoded.once("error", (error) => limiter.destroy(error));
  limiter.once("error", () => {
    source.destroy();
    decoded.destroy();
  });
  return decoded.pipe(limiter);
}
