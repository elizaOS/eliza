/**
 * Regression coverage for #22426 on the direct first-party callback path: the
 * HTTP body must be decoded from the concatenated raw bytes, not per TCP
 * chunk. WeChat's primary content is CJK (multi-byte UTF-8), so a code point
 * that straddles a TCP packet boundary must survive as exact content. These
 * tests drive the real listener over a raw TCP socket with a correctly signed
 * plaintext XML body split mid-character. The harness is real; only the
 * message sink is a recording array.
 */

import { createHash } from "node:crypto";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startCallbackServer } from "./callback-server";
import type { ResolvedWechatAccount, WechatMessageContext } from "./types";
import { buildWechatXml } from "./xml";

const TIMESTAMP = "1710969600";
const NONCE = "nonce-42";

const OFFICIAL: ResolvedWechatAccount = {
  id: "main",
  mode: "official-account",
  platformAccountId: "gh_app1",
  platformIdentity: "gh_app1",
  secret: "s",
  securityMode: "plaintext",
  tokenSecret: "token-oa",
  label: "OA",
};

function signature(): string {
  return createHash("sha1")
    .update([OFFICIAL.tokenSecret, TIMESTAMP, NONCE].sort().join(""), "utf8")
    .digest("hex");
}

function payloadWith(content: string, msgId: string): Buffer {
  const xml = buildWechatXml("xml", {
    ToUserName: "gh_app1",
    FromUserName: "openid-alice",
    CreateTime: "1710969600",
    MsgType: "text",
    Content: content,
    MsgId: msgId,
  });
  return Buffer.from(xml, "utf8");
}

function path(): string {
  return `/webhook/wechat/main?signature=${signature()}&timestamp=${TIMESTAMP}&nonce=${NONCE}`;
}

/**
 * Sends a raw HTTP/1.1 POST whose body is written in multiple socket frames at
 * the given byte offsets, so a multi-byte character can be forced to straddle a
 * TCP chunk boundary. Resolves with the parsed status line.
 */
function rawSplitPost(
  port: number,
  requestPath: string,
  body: Buffer,
  splitOffsets: number[],
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      const header = Buffer.from(
        `POST ${requestPath} HTTP/1.1\r\n` +
          `Host: 127.0.0.1\r\n` +
          `Content-Type: text/xml\r\n` +
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
          // Yield so each slice lands as its own read, reproducing genuine
          // TCP fragmentation rather than a single coalesced buffer.
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

describe("callback UTF-8 chunk-boundary integrity (#22426, direct path)", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers.length = 0;
  });

  async function startServer(received: WechatMessageContext[]) {
    const handle = await startCallbackServer({
      port: 0,
      accounts: [OFFICIAL],
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
      clock: { now: () => 1_710_969_600_000 },
    });
    closers.push(handle.close);
    return handle.port;
  }

  it("delivers exact CJK content when a character is split across TCP writes", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);
    const content = "价格是多少钱";
    const body = payloadWith(content, "utf8-1");

    const contentByteStart = body.indexOf(Buffer.from(content, "utf8"));
    expect(contentByteStart).toBeGreaterThan(0);

    const res = await rawSplitPost(port, path(), body, [contentByteStart + 1]);

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe(content);
    expect(received[0]?.content).not.toContain("￿");
  });

  it("survives boundaries at every byte offset inside the CJK run", async () => {
    const content = "订单号是多少";
    const body = payloadWith(content, "utf8-sweep");
    const contentByteStart = body.indexOf(Buffer.from(content, "utf8"));
    const runBytes = Buffer.from(content, "utf8").length;

    for (let offset = 1; offset < runBytes; offset += 1) {
      const received: WechatMessageContext[] = [];
      const port = await startServer(received);
      const res = await rawSplitPost(port, path(), body, [
        contentByteStart + offset,
      ]);
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
      expect(received[0]?.content).toBe(content);
    }
  });

  it("reassembles a 4-byte emoji split across three writes", async () => {
    const received: WechatMessageContext[] = [];
    const port = await startServer(received);
    const content = "笑一个😀谢谢";
    const body = payloadWith(content, "utf8-emoji");
    const emojiByteStart = body.indexOf(Buffer.from("😀", "utf8"));
    expect(emojiByteStart).toBeGreaterThan(0);

    const res = await rawSplitPost(port, path(), body, [
      emojiByteStart + 1,
      emojiByteStart + 3,
    ]);

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe(content);
    expect(received[0]?.content).not.toContain("￿");
  });

  it("still returns 413 when the buffered body exceeds maxBodyBytes", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await startCallbackServer({
      port: 0,
      accounts: [OFFICIAL],
      maxBodyBytes: 64,
      onMessage: (_accountId, msg) => {
        received.push(msg);
      },
    });
    closers.push(handle.close);

    const body = payloadWith("价格".repeat(200), "utf8-big");
    const res = await rawSplitPost(handle.port, path(), body, [40]);

    expect(res.status).toBe(413);
    expect(received).toHaveLength(0);
  });
});
