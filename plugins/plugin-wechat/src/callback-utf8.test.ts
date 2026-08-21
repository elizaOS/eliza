/**
 * Regression coverage for #22426: the webhook body must be decoded from the
 * concatenated raw bytes, not per TCP chunk. WeChat's primary content is CJK
 * (multi-byte UTF-8), so a code point that straddles a TCP packet boundary was
 * previously decoded as U+FFFD replacement characters on both sides of the
 * split. These tests drive the real listener over a raw TCP socket and split
 * the body mid-character to prove exact-content delivery survives fragmentation
 * without regressing the buffered-size 413 guard. The harness is real: only the
 * message sink is a recording array.
 */

import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startCallbackServer } from "./callback-server";
import type { WechatMessageContext } from "./types";

const VALID_MS = 1_710_969_600_000;

function payloadWith(content: string): Buffer {
  return Buffer.from(
    JSON.stringify({
      data: {
        type: 60001,
        sender: "alice",
        recipient: "bot",
        content,
        timestamp: VALID_MS,
        msgId: "utf8-1",
      },
    }),
    "utf8",
  );
}

/**
 * Sends a raw HTTP/1.1 POST whose body is written in multiple socket frames at
 * the given byte offsets, so a multi-byte character can be forced to straddle a
 * TCP chunk boundary. Resolves with the parsed status line once the server
 * responds and closes the socket.
 */
function rawSplitPost(
  port: number,
  path: string,
  apiKey: string,
  body: Buffer,
  splitOffsets: number[],
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const header = Buffer.from(
        `POST ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `x-api-key: ${apiKey}\r\n` +
          `Content-Type: application/json\r\n` +
          `Content-Length: ${body.length}\r\n` +
          `Connection: close\r\n\r\n`,
        "utf8",
      );
      socket.write(header);

      const bounds = [0, ...splitOffsets, body.length];
      let index = 0;
      const writeNext = () => {
        if (index >= bounds.length - 1) {
          return;
        }
        const start = bounds[index];
        const end = bounds[index + 1];
        index += 1;
        socket.write(body.subarray(start, end), () => {
          // Yield to the event loop so each slice lands as its own read on the
          // server, reproducing genuine TCP fragmentation rather than a single
          // coalesced buffer.
          setTimeout(writeNext, 5);
        });
      };
      writeNext();
    });

    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => {
      const response = Buffer.concat(chunks).toString("utf8");
      const statusMatch = /^HTTP\/1\.1 (\d{3})/.exec(response);
      resolve({ status: statusMatch ? Number(statusMatch[1]) : 0 });
    });
    socket.on("error", reject);
  });
}

describe("webhook UTF-8 chunk-boundary integrity (#22426)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers.length = 0;
  });

  async function startServer(received: WechatMessageContext[]) {
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
    });
    closers.push(handle.close);
    return handle.port;
  }

  it("delivers exact CJK content when a character is split across TCP writes", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);
    const content = "价格是多少钱";
    const body = payloadWith(content);

    // The first CJK character "价" begins immediately after `"content":"` in
    // the serialized JSON. Split one byte into it so its three UTF-8 bytes land
    // on both sides of the boundary.
    const contentByteStart = body.indexOf(Buffer.from(content, "utf8"));
    expect(contentByteStart).toBeGreaterThan(0);

    const res = await rawSplitPost(
      port,
      "/webhook/wechat/main",
      "key-main",
      body,
      [contentByteStart + 1],
    );

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe(content);
    expect(received[0]?.content).not.toContain("\uFFFD");
  });

  it("survives boundaries at every byte offset inside the CJK run", async () => {
    const content = "订单号是多少";
    const body = payloadWith(content);
    const contentByteStart = body.indexOf(Buffer.from(content, "utf8"));
    const runBytes = Buffer.from(content, "utf8").length;

    for (let offset = 1; offset < runBytes; offset += 1) {
      const received: WechatMessageContext[] = [];
      const port = await startServer(received);
      const res = await rawSplitPost(
        port,
        "/webhook/wechat/main",
        "key-main",
        body,
        [contentByteStart + offset],
      );
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toBe(content);
    }
  });

  it("reassembles a 4-byte emoji surrogate split across three writes", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);
    // U+1F600 GRINNING FACE encodes to four UTF-8 bytes (F0 9F 98 80).
    const content = "笑一个😀谢谢";
    const body = payloadWith(content);
    const emojiByteStart = body.indexOf(Buffer.from("😀", "utf8"));
    expect(emojiByteStart).toBeGreaterThan(0);

    const res = await rawSplitPost(
      port,
      "/webhook/wechat/main",
      "key-main",
      body,
      [emojiByteStart + 1, emojiByteStart + 3],
    );

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe(content);
    expect(received[0]?.content).not.toContain("\uFFFD");
  });

  it("still returns 413 when the buffered body exceeds maxBodyBytes", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key-main" }],
      maxBodyBytes: 64,
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
    });
    closers.push(handle.close);

    // A body far larger than the 64-byte cap, delivered in two writes so the
    // limit is crossed by the accumulated buffered size, not a single chunk.
    const body = payloadWith("价格".repeat(200));
    const res = await rawSplitPost(
      handle.port,
      "/webhook/wechat/main",
      "key-main",
      body,
      [40],
    );

    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });
});
