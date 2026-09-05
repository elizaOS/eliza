/**
 * Verifies cloud-agent readBody preserves complete UTF-8 bodies across chunk boundaries.
 * Deterministic unit test exercising the exported _readBodyForTesting helper.
 */

import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { _readBodyForTesting } from "./cloud-agent-shared";

function makeReqWithChunks(chunks: Buffer[]): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  (req as unknown as { destroy: () => void }).destroy = () => {};
  queueMicrotask(() => {
    for (const c of chunks) {
      req.emit("data", c);
    }
    req.emit("end");
  });
  return req;
}

function splitBuffer(buf: Buffer, at: number): [Buffer, Buffer] {
  return [buf.subarray(0, at), buf.subarray(at)];
}

describe("_readBodyForTesting preserves UTF-8 across chunk boundaries", () => {
  it("preserves a 2-byte accented character split across chunks", async () => {
    const payload = JSON.stringify({ username: "josé" });
    const buf = Buffer.from(payload, "utf-8");
    const splitAt = buf.indexOf(Buffer.from("é", "utf-8")) + 1;
    const [c1, c2] = splitBuffer(buf, splitAt);
    const req = makeReqWithChunks([c1, c2]);
    const body = await _readBodyForTesting(req);
    expect(body).toBe(payload);
    expect(JSON.parse(body).username).toBe("josé");
  });

  it("preserves a 3-byte CJK character split across chunks", async () => {
    const payload = JSON.stringify({ text: "中文测试" });
    const buf = Buffer.from(payload, "utf-8");
    const start = buf.indexOf(Buffer.from("文", "utf-8"));
    const splitAt = start + 1;
    const [c1, c2] = splitBuffer(buf, splitAt);
    const req = makeReqWithChunks([c1, c2]);
    const body = await _readBodyForTesting(req);
    expect(body).toBe(payload);
    expect(JSON.parse(body).text).toBe("中文测试");
  });

  it("preserves a 4-byte emoji split across chunks (1+3, 2+2, 3+1)", async () => {
    const payload = JSON.stringify({ text: "hello 🌟 world" });
    const buf = Buffer.from(payload, "utf-8");
    const emojiStart = buf.indexOf(Buffer.from("🌟", "utf-8"));
    for (const offset of [1, 2, 3]) {
      const splitAt = emojiStart + offset;
      const [c1, c2] = splitBuffer(buf, splitAt);
      const req = makeReqWithChunks([c1, c2]);
      const body = await _readBodyForTesting(req);
      expect(body).toBe(payload);
      expect(JSON.parse(body).text).toBe("hello 🌟 world");
    }
  });

  it("handles string chunks via Buffer conversion", async () => {
    const payload = JSON.stringify({ text: "café 🌏 naïve" });
    const req = new EventEmitter() as IncomingMessage;
    (req as unknown as { destroy: () => void }).destroy = () => {};
    queueMicrotask(() => {
      req.emit("data", payload.slice(0, 10));
      req.emit("data", payload.slice(10));
      req.emit("end");
    });
    const body = await _readBodyForTesting(req);
    expect(body).toBe(payload);
  });

  it("returns empty string for no chunks", async () => {
    const req = makeReqWithChunks([]);
    const body = await _readBodyForTesting(req);
    expect(body).toBe("");
  });

  it("rejects when body exceeds maxBytes", async () => {
    const payload = "a".repeat(100);
    const buf = Buffer.from(payload, "utf-8");
    const req = makeReqWithChunks([buf]);
    await expect(_readBodyForTesting(req, 10)).rejects.toThrow(
      "Request body too large",
    );
  });
});
