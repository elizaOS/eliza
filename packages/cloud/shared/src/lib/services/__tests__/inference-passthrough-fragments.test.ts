/** Transport fragmentation must not change the meter's complete text or receipts. */
import { describe, expect, test } from "bun:test";
import { createPassthroughStreamMeter } from "../inference-passthrough";

const encoder = new TextEncoder();
function observe(bytes: Uint8Array, lengths: readonly number[]) {
  const meter = createPassthroughStreamMeter({ startedAt: 0, now: () => 0 });
  let offset = 0;
  for (const length of lengths) {
    meter.observe(bytes.subarray(offset, offset + length));
    offset += length;
  }
  if (offset < bytes.length) meter.observe(bytes.subarray(offset));
  return meter.finish();
}
function fixedChunks(bytes: Uint8Array, length: number) {
  return observe(bytes, Array(Math.ceil(bytes.length / length)).fill(length));
}
function contentFrame(content: string) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`;
}
const usage =
  'data: {"usage":{"prompt_tokens":7,"completion_tokens":9,"total_tokens":16,"prompt_tokens_details":{"cached_tokens":2}}}\r\n\r\n';

describe("incremental passthrough line boundaries", () => {
  test("every split including multibyte UTF-8 and CRLF preserves content and usage", () => {
    const content = "hé🙂漢字\nsecond line";
    const bytes = encoder.encode(`: heartbeat\r\n\r\n${contentFrame(content)}${usage}data: [DONE]`);
    const whole = observe(bytes, [bytes.length]);
    expect(whole).toMatchObject({
      deliveredText: content,
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16, cacheReadInputTokens: 2 },
      sawDone: true,
      sawErrorFrame: false,
      readError: null,
    });
    for (let split = 0; split <= bytes.length; split++) {
      expect(observe(bytes, [split, bytes.length - split])).toEqual(whole);
    }
    expect(fixedChunks(bytes, 1)).toEqual(whole);
    expect(fixedChunks(bytes, 7)).toEqual(whole);
  });

  test("a long fragmented event retains every character without truncation", () => {
    const content = "a🙂é漢".repeat(131_072);
    const bytes = encoder.encode(`${contentFrame(content)}${usage}data: [DONE]\n\n`);
    const whole = observe(bytes, [bytes.length]);
    for (const size of [251, 4093, 16_384]) {
      const tail = fixedChunks(bytes, size);
      expect(tail).toEqual(whole);
      expect(tail.deliveredText).toBe(content);
    }
  });

  test("empty lines, malformed events and final unterminated data retain prior valid usage", () => {
    const bytes = encoder.encode(
      `${usage}\r\n\ndata: {invalid}\n\ndata: {"usage":{"prompt_tokens":"bad"}}\n\n${contentFrame("kept")}data: [DONE]`,
    );
    const whole = observe(bytes, [bytes.length]);
    expect(whole).toMatchObject({
      deliveredText: "kept",
      sawDone: true,
      usage: { inputTokens: 7, outputTokens: 9, totalTokens: 16 },
    });
    expect(fixedChunks(bytes, 3)).toEqual(whole);
  });

  test("abort does not parse an incomplete event and later bytes cannot change the terminal receipt", () => {
    const meter = createPassthroughStreamMeter({ startedAt: 0, now: () => 0 });
    meter.observe(encoder.encode(`${contentFrame("already delivered")}data: {"usage":`));
    const failure = new Error("client canceled");
    const tail = meter.fail(failure);
    expect(tail).toMatchObject({
      deliveredText: "already delivered",
      usage: null,
      sawDone: false,
      readError: failure,
    });
    meter.observe(encoder.encode('{"prompt_tokens":99}}\n\ndata: [DONE]\n\n'));
    expect(meter.finish()).toBe(tail);
    expect(tail.usage).toBeNull();
    expect(tail.sawDone).toBe(false);
  });

  test("an error after DONE remains observable until actual stream termination", () => {
    const bytes = encoder.encode(
      `${contentFrame("partial")}data: [DONE]\n\ndata: {"error":{"message":"late failure"}}\r\n`,
    );
    const whole = observe(bytes, [bytes.length]);
    expect(whole).toMatchObject({
      sawDone: true,
      sawErrorFrame: true,
      milestones: { completionMs: null },
    });
    expect(fixedChunks(bytes, 1)).toEqual(whole);
  });
});
