/**
 * Streaming SSE parser. Zero deps. Spec-compliant enough for HTML5 EventSource format.
 *
 * Handles:
 *   - multi-line `data:` (concatenated with `\n`)
 *   - leading-space stripping after the field colon
 *   - comment lines (start with `:`)
 *   - `event:`, `id:`, `retry:` directives
 *   - blank-line dispatch (LF, CRLF, or CR)
 *   - partial chunks across reads (boundaries at any byte)
 *   - final flush when the stream ends without trailing blank line
 *
 * Returns SSEEvent objects with whatever fields were set on that event.
 * Caller decides whether absent `data` / `event` matter for their protocol.
 */

export interface SSEEvent {
  event?: string;
  data?: string;
  id?: string;
  retry?: number;
}

interface MutableEvent {
  event?: string;
  dataLines: string[];
  id?: string;
  retry?: number;
  hasContent: boolean;
}

function emptyEvent(): MutableEvent {
  return { dataLines: [], hasContent: false };
}

function finalizeEvent(ev: MutableEvent): SSEEvent | null {
  if (!ev.hasContent) return null;
  const out: SSEEvent = {};
  if (ev.event !== undefined) out.event = ev.event;
  if (ev.dataLines.length > 0) out.data = ev.dataLines.join("\n");
  if (ev.id !== undefined) out.id = ev.id;
  if (ev.retry !== undefined) out.retry = ev.retry;
  return out;
}

function processLine(line: string, ev: MutableEvent): void {
  // Comment
  if (line.startsWith(":")) return;

  let field: string;
  let value: string;
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) {
    field = line;
    value = "";
  } else {
    field = line.slice(0, colonIdx);
    value = line.slice(colonIdx + 1);
    // per spec, strip a single leading space
    if (value.startsWith(" ")) value = value.slice(1);
  }

  switch (field) {
    case "event":
      ev.event = value;
      ev.hasContent = true;
      break;
    case "data":
      ev.dataLines.push(value);
      ev.hasContent = true;
      break;
    case "id":
      // per spec, NULL chars cause id to be ignored. We'll just check.
      if (!value.includes("\u0000")) {
        ev.id = value;
        ev.hasContent = true;
      }
      break;
    case "retry": {
      if (/^\d+$/.test(value)) {
        ev.retry = Number.parseInt(value, 10);
        ev.hasContent = true;
      }
      break;
    }
    default:
      // unknown field — ignore per spec
      break;
  }
}

/**
 * Parse a ReadableStream<Uint8Array> as Server-Sent Events. Yields each
 * dispatched event in order. Caller must consume to completion or call
 * `.return()` on the returned generator to release the stream lock.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let current = emptyEvent();
  // Track whether the last byte of the previous chunk was \r so we can
  // swallow a paired \n at the start of the next chunk (CRLF split across
  // chunk boundary).
  let pendingCR = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      let chunk = decoder.decode(value, { stream: true });
      if (chunk.length === 0) continue;

      if (pendingCR && chunk.charCodeAt(0) === 0x0a /* \n */) {
        chunk = chunk.slice(1);
      }
      pendingCR = false;
      if (chunk.length > 0 && chunk.charCodeAt(chunk.length - 1) === 0x0d) {
        pendingCR = true;
      }
      buffer += chunk;

      // Drain complete lines from buffer.
      let lineStart = 0;
      let i = 0;
      while (i < buffer.length) {
        const code = buffer.charCodeAt(i);
        if (code === 0x0a /* \n */) {
          const line = buffer.slice(lineStart, i);
          if (line.length === 0) {
            const ev = finalizeEvent(current);
            if (ev) yield ev;
            current = emptyEvent();
          } else {
            processLine(line, current);
          }
          i += 1;
          lineStart = i;
        } else if (code === 0x0d /* \r */) {
          const line = buffer.slice(lineStart, i);
          if (line.length === 0) {
            const ev = finalizeEvent(current);
            if (ev) yield ev;
            current = emptyEvent();
          } else {
            processLine(line, current);
          }
          i += 1;
          // Swallow following \n if present (CRLF). If we're at the end
          // of the buffer, pendingCR was already set above and we'll
          // handle the next chunk's leading \n.
          if (i < buffer.length && buffer.charCodeAt(i) === 0x0a) {
            i += 1;
            // Since we consumed a real \n here, this isn't the trailing
            // \r of the chunk. Nothing else to do; pendingCR stays
            // whatever the chunk-end check decided (which was based on
            // the very last byte of the chunk, not this position).
          }
          lineStart = i;
        } else {
          i += 1;
        }
      }
      buffer = buffer.slice(lineStart);
    }

    // Stream is done. Flush any trailing decoded bytes, but per SSE spec
    // (https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)
    // any incomplete event without a trailing blank line is discarded.
    const tail = decoder.decode();
    if (tail.length > 0) buffer += tail;
    // intentionally do NOT processLine(buffer) or finalize current here.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released or stream errored — ignore
    }
  }
}

/**
 * Wrapper that JSON.parses each event's `data` field. Skips events with no
 * data. Throws on malformed JSON unless `ignoreParseErrors` is set, in which
 * case those events are silently dropped.
 */
export async function* parseSSEJSON<T = unknown>(
  stream: ReadableStream<Uint8Array>,
  opts: { ignoreParseErrors?: boolean } = {},
): AsyncGenerator<{ event: string; data: T }> {
  for await (const ev of parseSSE(stream)) {
    if (ev.data === undefined) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(ev.data) as T;
    } catch (err) {
      if (opts.ignoreParseErrors) continue;
      throw err;
    }
    yield { event: ev.event ?? "message", data: parsed };
  }
}
