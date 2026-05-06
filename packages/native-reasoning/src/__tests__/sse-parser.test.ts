import { describe, expect, it } from "vitest";
import { parseSSE, parseSSEJSON, type SSEEvent } from "../sse-parser.js";

function streamFromChunks(
  chunks: (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const queue = chunks.map((c) => (typeof c === "string" ? enc.encode(c) : c));
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
      } else {
        controller.enqueue(next);
      }
    },
  });
}

function streamFromString(s: string): ReadableStream<Uint8Array> {
  return streamFromChunks([s]);
}

async function collect(
  stream: ReadableStream<Uint8Array>,
): Promise<SSEEvent[]> {
  const out: SSEEvent[] = [];
  for await (const ev of parseSSE(stream)) out.push(ev);
  return out;
}

describe("parseSSE", () => {
  it("parses a single event with data", async () => {
    const events = await collect(streamFromString("data: hello\n\n"));
    expect(events).toEqual([{ data: "hello" }]);
  });

  it("concatenates multi-line data with \\n", async () => {
    const events = await collect(
      streamFromString("data: line1\ndata: line2\ndata: line3\n\n"),
    );
    expect(events).toEqual([{ data: "line1\nline2\nline3" }]);
  });

  it("ignores comment lines (start with :)", async () => {
    const events = await collect(
      streamFromString(": this is a heartbeat\ndata: real\n\n"),
    );
    expect(events).toEqual([{ data: "real" }]);
  });

  it("captures event, id, and retry directives", async () => {
    const events = await collect(
      streamFromString(
        "event: response.created\nid: abc123\nretry: 5000\ndata: x\n\n",
      ),
    );
    expect(events).toEqual([
      { event: "response.created", id: "abc123", retry: 5000, data: "x" },
    ]);
  });

  it("ignores malformed retry (non-digits)", async () => {
    const events = await collect(
      streamFromString("retry: not-a-number\ndata: x\n\n"),
    );
    expect(events).toEqual([{ data: "x" }]);
  });

  it("dispatches multiple events back-to-back", async () => {
    const stream = streamFromString(
      "data: one\n\ndata: two\n\nevent: end\ndata: three\n\n",
    );
    const events = await collect(stream);
    expect(events).toEqual([
      { data: "one" },
      { data: "two" },
      { event: "end", data: "three" },
    ]);
  });

  it("handles partial chunks split at every byte boundary", async () => {
    const full = "event: msg\ndata: hello world\nid: 7\n\ndata: bye\n\n";
    const enc = new TextEncoder();
    const bytes = enc.encode(full);
    // Split into one-byte chunks.
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) {
      chunks.push(bytes.slice(i, i + 1));
    }
    const stream = streamFromChunks(chunks);
    const events = await collect(stream);
    expect(events).toEqual([
      { event: "msg", data: "hello world", id: "7" },
      { data: "bye" },
    ]);
  });

  it("handles CRLF line endings, including split across chunks", async () => {
    const events = await collect(
      streamFromChunks(["data: a\r", "\ndata: b\r\n\r\n"]),
    );
    expect(events).toEqual([{ data: "a\nb" }]);
  });

  it("strips a single leading space after the colon", async () => {
    const events = await collect(
      streamFromString("data:  two-spaces\ndata:no-space\n\n"),
    );
    // First line: ": " stripped → " two-spaces" (one leading space remains)
    // Second line: ":" no space → "no-space"
    expect(events).toEqual([{ data: " two-spaces\nno-space" }]);
  });

  it("treats lines without a colon as a field with empty value", async () => {
    // A bare `data` field with no value adds an empty data line.
    const events = await collect(streamFromString("data\ndata: hi\n\n"));
    expect(events).toEqual([{ data: "\nhi" }]);
  });

  it("does not dispatch a trailing event without blank-line terminator", async () => {
    const events = await collect(streamFromString("data: incomplete\n"));
    expect(events).toEqual([]);
  });

  it("releases the reader lock when the consumer breaks early", async () => {
    const stream = streamFromString("data: a\n\ndata: b\n\ndata: c\n\n");
    for await (const ev of parseSSE(stream)) {
      expect(ev.data).toBe("a");
      break;
    }
    // Reader should have been released — locked() means we can't read again
    // but the underlying stream is fine to discard. If releaseLock failed
    // with an error, the for-await wouldn't have returned cleanly.
    expect(stream.locked).toBe(false);
  });

  it("handles UTF-8 multibyte characters split across chunks", async () => {
    // "héllo" — é is two bytes in UTF-8 (0xC3 0xA9). Split between them.
    const enc = new TextEncoder();
    const full = enc.encode("data: héllo\n\n");
    // find the 0xC3
    const c3 = full.indexOf(0xc3);
    const a = full.slice(0, c3 + 1);
    const b = full.slice(c3 + 1);
    const events = await collect(streamFromChunks([a, b]));
    expect(events).toEqual([{ data: "héllo" }]);
  });
});

describe("parseSSEJSON", () => {
  it("parses JSON data fields", async () => {
    const stream = streamFromString(
      'event: foo\ndata: {"x":1}\n\nevent: bar\ndata: {"y":2}\n\n',
    );
    const out: { event: string; data: unknown }[] = [];
    for await (const ev of parseSSEJSON(stream)) out.push(ev);
    expect(out).toEqual([
      { event: "foo", data: { x: 1 } },
      { event: "bar", data: { y: 2 } },
    ]);
  });

  it("defaults event name to 'message' when absent", async () => {
    const stream = streamFromString('data: {"a":true}\n\n');
    const out: { event: string; data: unknown }[] = [];
    for await (const ev of parseSSEJSON(stream)) out.push(ev);
    expect(out).toEqual([{ event: "message", data: { a: true } }]);
  });

  it("throws on malformed JSON by default", async () => {
    const stream = streamFromString("data: not json\n\n");
    await expect(async () => {
      for await (const _ev of parseSSEJSON(stream)) {
        /* no-op */
      }
    }).rejects.toThrow();
  });

  it("skips malformed JSON when ignoreParseErrors is set", async () => {
    const stream = streamFromString('data: not json\n\ndata: {"ok":true}\n\n');
    const out: { event: string; data: unknown }[] = [];
    for await (const ev of parseSSEJSON(stream, { ignoreParseErrors: true })) {
      out.push(ev);
    }
    expect(out).toEqual([{ event: "message", data: { ok: true } }]);
  });

  it("skips events with no data field", async () => {
    const stream = streamFromString(
      'event: ping\n\nevent: msg\ndata: {"hi":1}\n\n',
    );
    const out: { event: string; data: unknown }[] = [];
    for await (const ev of parseSSEJSON(stream)) out.push(ev);
    expect(out).toEqual([{ event: "msg", data: { hi: 1 } }]);
  });
});
