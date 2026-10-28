/** Shared complete streamed-text ceiling for Node and Worker HTTP readers. */
export async function readTextWithinLimit(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
  rejectMalformedUtf8 = false,
): Promise<string> {
  signal?.throwIfAborted();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let rejectAbort: ((reason?: unknown) => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => {
    rejectAbort?.(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await (signal
        ? Promise.race([reader.read(), aborted])
        : reader.read());
      signal?.throwIfAborted();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error(
          `Response body exceeds the ${maxBytes}-byte safety ceiling`,
        );
      }
      chunks.push(value);
      bytes += value.byteLength;
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: rejectMalformedUtf8 }).decode(
      combined,
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
