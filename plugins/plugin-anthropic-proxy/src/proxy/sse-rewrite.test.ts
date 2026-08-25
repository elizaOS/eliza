import { describe, expect, it, vi } from "vitest";
import { createSseStream } from "./sse-rewrite";

function collect() {
  const emitted: string[] = [];
  const finished = vi.fn();
  const stream = createSseStream(
    (text) => text,
    (text) => emitted.push(text),
    finished
  );
  return { emitted, finished, stream };
}

describe("createSseStream", () => {
  it("buffers an event until its blank-line terminator", () => {
    const { emitted, stream } = collect();
    stream.write(Buffer.from("data: hello"));
    expect(emitted).toEqual([]);
    stream.write(Buffer.from("\n\n"));
    expect(emitted).toEqual(["data: hello\n\n"]);
  });

  it("emits one event per blank-line terminator within a chunk", () => {
    const { emitted, stream } = collect();
    stream.write(Buffer.from("data: one\n\ndata: two\n\n"));
    expect(emitted).toEqual(["data: one\n\n", "data: two\n\n"]);
  });

  it("splits events on CRLF terminators", () => {
    const { emitted, stream } = collect();
    stream.write(Buffer.from("data: a\r\n\r\ndata: b\r\n\r\n"));
    expect(emitted).toEqual(["data: a\r\n\r\n", "data: b\r\n\r\n"]);
  });

  it("accepts a bare CR blank line as a terminator", () => {
    const { emitted, stream } = collect();
    stream.write(Buffer.from("data: a\r\r"));
    expect(emitted).toEqual(["data: a\r\r"]);
  });

  it("does not backtrack a CRLF line ending into CR + LF blank lines", () => {
    const { emitted, stream } = collect();
    stream.write(Buffer.from("data: x\r\n\n"));
    expect(emitted).toEqual(["data: x\r\n\n"]);
  });

  it("applies the reverse map exactly once per event", () => {
    const reverseFn = vi.fn((text: string) => text.toUpperCase());
    const emitted: string[] = [];
    const stream = createSseStream(
      reverseFn,
      (text) => emitted.push(text),
      () => {}
    );
    stream.write(Buffer.from("data: one\n\n"));
    expect(reverseFn).toHaveBeenCalledTimes(1);
    expect(emitted).toEqual(["DATA: ONE\n\n"]);
  });

  it("applies the reverse map per event, not per chunk", () => {
    const reverseFn = vi.fn((text: string) => text.toUpperCase());
    const emitted: string[] = [];
    const stream = createSseStream(
      reverseFn,
      (text) => emitted.push(text),
      () => {}
    );
    stream.write(Buffer.from("data: one\n\n"));
    stream.write(Buffer.from("data: two\n\n"));
    expect(reverseFn).toHaveBeenCalledTimes(2);
    expect(emitted).toEqual(["DATA: ONE\n\n", "DATA: TWO\n\n"]);
  });

  it("never merges a token split across two separate events", () => {
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => text.replace("secret", "REDACTED"),
      (text) => emitted.push(text),
      () => {}
    );
    stream.write(Buffer.from("data: se\n\n"));
    stream.write(Buffer.from("cret\n\n"));
    expect(emitted).toEqual(["data: se\n\n", "cret\n\n"]);
  });

  it("decodes multi-byte characters split across chunk boundaries without U+FFFD", () => {
    const { emitted, stream } = collect();
    const bytes = Buffer.from("data: 数据\n\n", "utf8");
    const firstNonAscii = bytes.findIndex((b) => b >= 0x80);
    // split inside the first multi-byte sequence
    const first = bytes.subarray(0, firstNonAscii + 1);
    const second = bytes.subarray(firstNonAscii + 1);
    stream.write(first);
    stream.write(second);
    expect(emitted).toEqual(["data: 数据\n\n"]);
    expect(emitted[0]).not.toContain("\uFFFD");
  });

  it("flushes buffered text without a terminator on end()", () => {
    const { emitted, finished, stream } = collect();
    stream.write(Buffer.from("data: tail"));
    stream.end();
    expect(emitted).toEqual(["data: tail"]);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("emits nothing and still finishes when end() sees no buffered text", () => {
    const { emitted, finished, stream } = collect();
    stream.end();
    expect(emitted).toEqual([]);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it("maps the pending tail on end() before finishing", () => {
    const emitted: string[] = [];
    const stream = createSseStream(
      (text) => text.replace("raw", "mapped"),
      (text) => emitted.push(text),
      () => {}
    );
    stream.write(Buffer.from("data: raw"));
    stream.end();
    expect(emitted).toEqual(["data: mapped"]);
  });
});
