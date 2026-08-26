/**
 * Verifies secrets manager and inventory body readers preserve complete UTF-8 bodies.
 * Deterministic unit tests exercising the exported buffering helpers.
 */

import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { _readJsonBodyForTesting } from "./secrets-inventory-routes";
import { _readBodyForTesting } from "./secrets-manager-routes";

function makeChunkedReq(chunks: Buffer[]): IncomingMessage {
  const stream = Readable.from(chunks);
  return Object.assign(stream, {
    method: "POST",
    url: "/test",
  }) as unknown as IncomingMessage;
}

function splitBuffer(buf: Buffer, at: number): [Buffer, Buffer] {
  return [buf.subarray(0, at), buf.subarray(at)];
}

describe("secrets-manager _readBodyForTesting preserves UTF-8 across chunks", () => {
  it("preserves a 2-byte character split across chunks", async () => {
    const payload = JSON.stringify({ username: "josé", password: "s3cret" });
    const buf = Buffer.from(payload, "utf-8");
    const splitAt = buf.indexOf(Buffer.from("é", "utf-8")) + 1;
    const [c1, c2] = splitBuffer(buf, splitAt);
    const req = makeChunkedReq([c1, c2]);
    const body = await _readBodyForTesting(req as IncomingMessage);
    expect(body).toBe(payload);
    expect(JSON.parse(body).username).toBe("josé");
  });

  it("preserves a 3-byte CJK character split across chunks", async () => {
    const payload = JSON.stringify({ text: "中文测试" });
    const buf = Buffer.from(payload, "utf-8");
    const start = buf.indexOf(Buffer.from("文", "utf-8"));
    const splitAt = start + 1;
    const [c1, c2] = splitBuffer(buf, splitAt);
    const req = makeChunkedReq([c1, c2]);
    const body = await _readBodyForTesting(req as IncomingMessage);
    expect(body).toBe(payload);
    expect(JSON.parse(body).text).toBe("中文测试");
  });

  it("preserves a 4-byte emoji split across chunks at every offset", async () => {
    const payload = JSON.stringify({ text: "hello 🌟 world" });
    const buf = Buffer.from(payload, "utf-8");
    const emojiStart = buf.indexOf(Buffer.from("🌟", "utf-8"));
    for (const offset of [1, 2, 3]) {
      const splitAt = emojiStart + offset;
      const [c1, c2] = splitBuffer(buf, splitAt);
      const req = makeChunkedReq([c1, c2]);
      const body = await _readBodyForTesting(req as IncomingMessage);
      expect(body).toBe(payload);
      expect(JSON.parse(body).text).toBe("hello 🌟 world");
    }
  });

  it("handles string chunks via Buffer conversion", async () => {
    // Simulate Readable emitting strings (Node can emit strings if not objectMode false?)
    // Our helper converts string -> Buffer, so test via Readable.from of strings.
    const payload = JSON.stringify({ text: "emoji 🌏 split via string" });
    const stream = Readable.from([payload.slice(0, 10), payload.slice(10)]);
    const req = Object.assign(stream, {
      method: "POST",
      url: "/test",
    }) as unknown as IncomingMessage;
    const body = await _readBodyForTesting(req);
    expect(body).toBe(payload);
  });

  it("returns empty string for no chunks", async () => {
    const req = makeChunkedReq([]);
    const body = await _readBodyForTesting(req as IncomingMessage);
    expect(body).toBe("");
  });
});

describe("secrets-inventory _readJsonBodyForTesting preserves UTF-8 and handles edges", () => {
  it("preserves a 4-byte emoji split across chunks and parses JSON", async () => {
    const obj = { key: "k1", value: "hello 🌟 world" };
    const payload = JSON.stringify(obj);
    const buf = Buffer.from(payload, "utf-8");
    const emojiStart = buf.indexOf(Buffer.from("🌟", "utf-8"));
    const [c1, c2] = splitBuffer(buf, emojiStart + 2);
    const req = makeChunkedReq([c1, c2]);
    const parsed = await _readJsonBodyForTesting(req as IncomingMessage);
    expect(parsed).toEqual(obj);
  });

  it("preserves 3-byte CJK split and parses JSON", async () => {
    const obj = { text: "中文测试" };
    const payload = JSON.stringify(obj);
    const buf = Buffer.from(payload, "utf-8");
    const start = buf.indexOf(Buffer.from("文", "utf-8"));
    const [c1, c2] = splitBuffer(buf, start + 1);
    const req = makeChunkedReq([c1, c2]);
    const parsed = await _readJsonBodyForTesting(req as IncomingMessage);
    expect(parsed).toEqual(obj);
  });

  it("returns empty object for empty body", async () => {
    const req = makeChunkedReq([]);
    const parsed = await _readJsonBodyForTesting(req as IncomingMessage);
    expect(parsed).toEqual({});
  });

  it("returns null for invalid JSON", async () => {
    const req = makeChunkedReq([Buffer.from("{ not json", "utf-8")]);
    const parsed = await _readJsonBodyForTesting(req as IncomingMessage);
    expect(parsed).toBeNull();
  });
});
