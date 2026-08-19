/**
 * Decoded-byte budget for the mobile DNS-pinned fetch wrapper. Gzip/deflate/br
 * inflate is credited here so a tiny compressed body cannot materialize tens
 * of megabytes before the Response stream is handed to the caller.
 */

export const MAX_MOBILE_DNS_DECODED_BYTES = 64 * 1024 * 1024;

export class MobileFetchDecodeBudgetError extends Error {
  readonly code = "MOBILE_FETCH_DECODE_TOO_LARGE";
  constructor(
    readonly decodedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `mobile DNS fetch decoded body exceeded ${maxBytes} bytes (got ${decodedBytes})`,
    );
    this.name = "MobileFetchDecodeBudgetError";
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
