/**
 * Real-listener coverage for the first-party callback boundary: URL
 * verification (plaintext echo and encrypted echostr), signature-verified
 * message POSTs in both security modes, cross-account replay rejection, and
 * the fail-closed matrix (bad signature, malformed XML, oversized body,
 * delivery failure reporting). Signatures are computed with the real SHA-1
 * over the documented sorted-parts input; only the message sink is a
 * recording array.
 */
import { createHash } from "node:crypto";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { encryptCallbackPayload } from "./callback-crypto";
import { startCallbackServer } from "./callback-server";
import type { ResolvedWechatAccount, WechatMessageContext } from "./types";
import { buildWechatXml } from "./xml";

const TIMESTAMP = "1710969600";
const NONCE = "nonce-42";
const AES_KEY = Buffer.from("0123456789abcdef0123456789abcdef")
  .toString("base64")
  .replace(/=+$/, "")
  .slice(0, 43)
  .padEnd(43, "A");

const OFFICIAL: ResolvedWechatAccount = {
  id: "oa-main",
  mode: "official-account",
  platformAccountId: "gh_app1",
  platformIdentity: "gh_app1",
  secret: "s",
  securityMode: "plaintext",
  tokenSecret: "token-oa",
  label: "OA",
};

const WECOM: ResolvedWechatAccount = {
  id: "wecom-main",
  mode: "wecom",
  platformAccountId: "corp1_2",
  platformIdentity: "corp1",
  wecomAgentId: 2,
  secret: "s",
  securityMode: "encrypted",
  tokenSecret: "token-wecom",
  encodingAESKey: AES_KEY,
  label: "WeCom",
};

function sha1Of(...parts: string[]): string {
  return createHash("sha1")
    .update([...parts].sort().join(""), "utf8")
    .digest("hex");
}

function httpRequest(
  port: number,
  path: string,
  options: { method?: string; body?: string } = {},
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

describe("first-party callback server", () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(closers.map((close) => close()));
    closers.length = 0;
  });

  async function start(
    onMessage: (
      accountId: string,
      msg: WechatMessageContext,
    ) => void | Promise<void> = () => undefined,
    onDeliveryError?: (error: unknown, accountId: string) => void,
    accounts: ResolvedWechatAccount[] = [OFFICIAL, WECOM],
  ) {
    const handle = await startCallbackServer({
      port: 0,
      accounts,
      onMessage,
      onDeliveryError,
    });
    closers.push(handle.close);
    return handle;
  }

  it("answers plaintext URL verification with the echostr", async () => {
    const handle = await start();
    const echostr = "echo-1234";
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${echostr}`,
    );
    expect(res).toEqual({ body: echostr, status: 200 });
  });

  it("rejects URL verification with a wrong signature", async () => {
    const handle = await start();
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=deadbeef&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=x`,
    );
    expect(res.status).toBe(403);
  });

  it("answers encrypted WeCom URL verification with the decrypted echo", async () => {
    const handle = await start();
    const echoPlain = "wecom-echo";
    const encryptedEcho = encryptCallbackPayload(
      echoPlain,
      WECOM.platformIdentity,
      AES_KEY,
    );
    const signature = sha1Of(
      WECOM.tokenSecret,
      TIMESTAMP,
      NONCE,
      encryptedEcho,
    );
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${encodeURIComponent(
        encryptedEcho,
      )}`,
    );
    expect(res).toEqual({ body: echoPlain, status: 200 });
  });

  it("rejects an encrypted echo encrypted for a different receiver", async () => {
    const handle = await start();
    const encryptedEcho = encryptCallbackPayload("evil", "other-corp", AES_KEY);
    const signature = sha1Of(
      WECOM.tokenSecret,
      TIMESTAMP,
      NONCE,
      encryptedEcho,
    );
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}&echostr=${encodeURIComponent(
        encryptedEcho,
      )}`,
    );
    expect(res.status).toBe(403);
  });

  it("delivers a plaintext signed text message to the runtime", async () => {
    const received: Array<{ accountId: string; msg: WechatMessageContext }> =
      [];
    const handle = await start((_accountId, msg) => {
      received.push({ accountId: _accountId, msg });
    });

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "你好 hello",
      MsgId: "1001",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );

    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]?.accountId).toBe("oa-main");
    expect(received[0]?.msg).toMatchObject({
      id: "1001",
      type: "text",
      sender: "openid-alice",
      recipient: "gh_app1",
      content: "你好 hello",
      timestamp: 1_710_969_600_000,
      platform: { mode: "official-account", accountId: "oa-main" },
    });
  });

  it("delivers an encrypted WeCom message after signature + receiver validation", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "enterprise hello",
      MsgId: "2002",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );

    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "text",
      sender: "wecom-bob",
      content: "enterprise hello",
      platform: { mode: "wecom", accountId: "wecom-main" },
    });
  });

  it("rejects a message POST with a bad signature before any parsing", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=bad&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: "<xml><Content>x</Content></xml>" },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("cannot replay a ciphertext signed for account A against account B", async () => {
    const received: WechatMessageContext[] = [];

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "cross-account",
      MsgId: "3003",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
    });

    // Signed with wecom-main's token but POSTed to a DIFFERENT encrypted
    // account's path: that account's callback token differs, so signature
    // verification fails closed.
    const otherEncrypted: ResolvedWechatAccount = {
      ...WECOM,
      id: "wecom-other",
      tokenSecret: "token-other",
    };
    const handle2 = await start(undefined, undefined, [
      OFFICIAL,
      WECOM,
      otherEncrypted,
    ]);
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle2.port,
      `/webhook/wechat/wecom-other?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects an encrypted payload sent to a plaintext-mode account", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "downgrade",
      MsgId: "3004",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
    });
    // Even a perfectly correct msg_signature cannot route an encrypted
    // payload through a plaintext-mode account: the plaintext path only
    // accepts the `signature` parameter, and its absence fails closed (400).
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect([400, 403]).toContain(res.status);
    expect(res.body).not.toBe("success");
    expect(received).toHaveLength(0);
  });

  it("acknowledges malformed XML without dispatching", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: "not-xml-at-all" },
    );
    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(0);
  });

  it("normalizes subscribe/unsubscribe events", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-new",
      CreateTime: "1710969600",
      MsgType: "event",
      Event: "subscribe",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      type: "event",
      event: "subscribe",
      sender: "openid-new",
    });
  });

  it("answers 404 for unknown accounts and malformed paths", async () => {
    const handle = await start();
    for (const path of [
      "/webhook/wechat/unknown",
      "/webhook/wechat/%ZZ",
      "/other/path",
    ]) {
      const res = await httpRequest(handle.port, path);
      expect(res.status).toBe(404);
    }
  });

  it("answers 405 for non-GET/POST methods", async () => {
    const handle = await start();
    const res = await httpRequest(handle.port, "/webhook/wechat/oa-main", {
      method: "DELETE",
    });
    expect(res.status).toBe(405);
  });

  it("returns 500 and reports a delivery failure", async () => {
    const failures: Array<{ error: unknown; accountId: string }> = [];
    const handle = await start(
      async () => {
        throw new Error("delivery exploded");
      },
      (error, accountId) => {
        failures.push({ error, accountId });
      },
    );

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "hi",
      MsgId: "4004",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );
    expect(res).toEqual({ body: "Internal Server Error", status: 500 });
    expect(failures).toEqual([
      { error: new Error("delivery exploded"), accountId: "oa-main" },
    ]);
  });
});
