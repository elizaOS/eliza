/**
 * Bounded reader for `POST /api/first-run`. Origin concatenated the entire
 * request stream before JSON.parse, so a multi-megabyte body was allocated
 * before the handler could reject it. Fail closed at the byte cap.
 */
import type http from "node:http";

export const MAX_FIRST_RUN_BODY_BYTES = 1_048_576;

export class FirstRunBodyTooLargeError extends Error {
  readonly code = "FIRST_RUN_BODY_TOO_LARGE";
  constructor(
    readonly receivedBytes: number,
    readonly maxBytes: number,
  ) {
    super(
      `first-run request body exceeded ${maxBytes} bytes (got ${receivedBytes})`,
    );
    this.name = "FirstRunBodyTooLargeError";
  }
}

/** Read the raw POST body and throw before the allocation exceeds the cap. */
export async function readFirstRunRawBody(
  req: http.IncomingMessage,
  maxBytes = MAX_FIRST_RUN_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    total += buf.length;
    if (total > maxBytes) {
      req.destroy();
      throw new FirstRunBodyTooLargeError(total, maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}
