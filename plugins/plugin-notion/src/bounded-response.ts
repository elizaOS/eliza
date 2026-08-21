/**
 * Reads untrusted HTTP response bodies with a hard allocation limit and one
 * deadline covering the complete stream. The reader is cancelled as soon as
 * the limit or deadline is crossed so rejected bodies are not drained.
 */
export interface BoundedResponseErrors {
  tooLarge(declaredBytes: number | null): Error;
  timedOut(): Error;
  readFailed(cause: unknown): Error;
}

export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  errors: BoundedResponseErrors
): Promise<Uint8Array> {
  const declaredBytes = parseContentLength(response.headers.get("Content-Length"));
  if (declaredBytes !== null && declaredBytes > maxBytes) {
    cancelBody(response.body);
    throw errors.tooLarge(declaredBytes);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      cancelReader(reader);
      throw errors.timedOut();
    }
    let result: ReadableStreamReadResult<Uint8Array>;
    try {
      result = await readBeforeDeadline(reader, remainingMs);
    } catch (cause) {
      cancelReader(reader);
      if (cause instanceof BodyDeadlineError) throw errors.timedOut();
      throw errors.readFailed(cause);
    }
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      cancelReader(reader);
      throw errors.tooLarge(declaredBytes);
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBeforeDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  remainingMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BodyDeadlineError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class BodyDeadlineError extends Error {}

function parseContentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  body.cancel().catch(() => {
    // error-policy:J6 response rejection is already authoritative; cancellation is teardown only.
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  reader.cancel().catch(() => {
    // error-policy:J6 response rejection is already authoritative; cancellation is teardown only.
  });
}
