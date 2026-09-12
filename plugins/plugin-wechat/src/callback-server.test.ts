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

/**
 * Deterministic clock anchored to the fixed TIMESTAMP: freshness passes for
 * TIMESTAMP and fails for anything minutes away, without real-time waits.
 */
const FIXED_NOW_MS = 1_710_969_600_000;
const CLOCK = { now: () => FIXED_NOW_MS };
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
  platformAccountId: "wx-app-id-1",
  platformIdentity: "wx-app-id-1",
  secret: "s",
  securityMode: "plaintext",
  tokenSecret: "token-oa",
  // gh_ original ID from the MP console; the inbound ToUserName.
  callbackIdentity: "gh_app1",
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
  callbackIdentity: "corp1",
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

/** Posts raw bytes verbatim — required for byte-identity assertions. */
function httpRequestRaw(
  port: number,
  path: string,
  body: Buffer,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: "127.0.0.1", port, path, method: "POST" },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.write(body);
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
      clock: CLOCK,
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

  it("rejects a plaintext message addressed to a different gh_ receiver", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_other_account",
      FromUserName: "openid-alice",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "cross-receiver",
      MsgId: "5001",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("skips receiver binding for an official account without callbackId", async () => {
    const received: WechatMessageContext[] = [];
    const noBinding: ResolvedWechatAccount = {
      ...OFFICIAL,
      id: "oa-nobind",
      callbackIdentity: undefined,
    };
    const handle = await start(
      (_id, msg) => {
        received.push(msg);
      },
      undefined,
      [noBinding],
    );

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_whatever",
      FromUserName: "openid-alice",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "legacy config",
      MsgId: "5002",
    });
    const signature = sha1Of(noBinding.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-nobind?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );
    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(1);
  });

  it("rejects a WeCom message whose AgentID targets a different agent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "wrong agent",
      MsgId: "5003",
      AgentID: "999",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "999",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("accepts a CDATA-wrapped encrypted envelope as the platform emits it", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml =
      "<xml><ToUserName><![CDATA[corp1]]></ToUserName><FromUserName><![CDATA[wecom-bob]]></FromUserName><CreateTime>1710969600</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[enterprise cdata hello]]></Content><MsgId>5004</MsgId><AgentID>2</AgentID></xml>";
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    // The outer envelope the platform actually POSTs wraps Encrypt in CDATA.
    const envelope = `<xml><ToUserName><![CDATA[corp1]]></ToUserName><Encrypt><![CDATA[${encrypt}]]></Encrypt><AgentID><![CDATA[2]]></AgentID></xml>`;
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
      content: "enterprise cdata hello",
      agentId: 2,
    });
  });

  it("rejects an outer-envelope AgentID that targets a different agent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    // Inner XML carries NO AgentID; only the outer envelope does (999).
    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "outer-only wrong agent",
      MsgId: "5005",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "999",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects outer and inner AgentIDs that disagree", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "disagreeing agents",
      MsgId: "5006",
      AgentID: "2",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "999",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects a WeCom event whose AgentID targets a different agent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: "1710969600",
      MsgType: "event",
      Event: "enter_agent",
      AgentID: "999",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "999",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("binds the encrypted framing receiver to the appId for official accounts", async () => {
    const received: WechatMessageContext[] = [];
    const encryptedOa: ResolvedWechatAccount = {
      ...OFFICIAL,
      id: "oa-enc",
      securityMode: "encrypted",
      encodingAESKey: AES_KEY,
    };
    const handle = await start(
      (_id, msg) => {
        received.push(msg);
      },
      undefined,
      [encryptedOa],
    );

    // Framing receiver = appId (wx-app-id-1); inner ToUserName = gh_ original.
    const innerXml = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: "1710969600",
      MsgType: "text",
      Content: "framing is appId",
      MsgId: "5007",
    });
    const encrypt = encryptCallbackPayload(
      innerXml,
      encryptedOa.platformIdentity,
      AES_KEY,
    );
    const envelope = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      Encrypt: encrypt,
    });
    const signature = sha1Of(
      encryptedOa.tokenSecret,
      TIMESTAMP,
      NONCE,
      encrypt,
    );
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-enc?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(1);

    // A ciphertext framed for a DIFFERENT appId is rejected even though the
    // signature token matches (cross-app replay under one callback token).
    const encryptOther = encryptCallbackPayload(
      innerXml,
      "wx-other-app",
      AES_KEY,
    );
    const envelopeOther = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      Encrypt: encryptOther,
    });
    const signatureOther = sha1Of(
      encryptedOa.tokenSecret,
      TIMESTAMP,
      NONCE,
      encryptOther,
    );
    const resOther = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-enc?msg_signature=${signatureOther}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelopeOther },
    );
    expect(resOther.status).toBe(403);
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

  it("rejects a signature whose timestamp is outside the freshness window", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    // Perfectly signed, but 10 minutes before the pinned clock (window: 5).
    const stale = "1710969000";
    const signature = sha1Of(OFFICIAL.tokenSecret, stale, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${stale}&nonce=${NONCE}`,
      {
        method: "POST",
        body: buildWechatXml("xml", {
          ToUserName: "gh_app1",
          FromUserName: "openid-alice",
          CreateTime: stale,
          MsgType: "text",
          Content: "stale replay",
          MsgId: "6001",
        }),
      },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects a different body replayed under a captured plaintext signature", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const original = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "original body",
      MsgId: "6002",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const first = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: original },
    );
    expect(first).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(1);

    // Same captured signature triple, SUBSTITUTED body: must be rejected even
    // though the signature itself is valid — plaintext signatures do not
    // cover the body, so replay state is the binding.
    const substituted = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "attacker body",
      MsgId: "6003",
    });
    const replay = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: substituted },
    );
    expect(replay.status).toBe(403);
    expect(received).toHaveLength(1);
  });

  it("allows byte-identical platform retries of a delivered message", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const xml = buildWechatXml("xml", {
      ToUserName: "gh_app1",
      FromUserName: "openid-alice",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "retry me",
      MsgId: "6004",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await httpRequest(
        handle.port,
        `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
        { method: "POST", body: xml },
      );
      expect(res.status).toBe(200);
    }
    expect(received).toHaveLength(3);
  });

  it("rejects a plaintext message whose ToUserName is absent (bound account)", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    // No ToUserName at all: an absent receiver cannot be verified against the
    // configured gh_ identity and fails closed.
    const xml = buildWechatXml("xml", {
      FromUserName: "openid-alice",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "missing receiver",
      MsgId: "6005",
    });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: xml },
    );
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects an encrypted WeCom message whose inner ToUserName is absent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      FromUserName: "wecom-bob",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "missing inner receiver",
      MsgId: "6006",
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
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("rejects a malformed envelope AgentID instead of treating it as absent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "malformed outer agent",
      MsgId: "6007",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    // Outer envelope AgentID is garbage: must be a typed 400, never parsed
    // as "absent" (which would bypass agent binding entirely).
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "invalid",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    expect(res.status).toBe(400);
    expect(received).toHaveLength(0);
  });

  it("drops a malformed inner AgentID instead of treating it as absent", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    const innerXml = buildWechatXml("xml", {
      ToUserName: "corp1",
      FromUserName: "wecom-bob",
      CreateTime: TIMESTAMP,
      MsgType: "text",
      Content: "malformed inner agent",
      MsgId: "6008",
      AgentID: "2evil",
    });
    const encrypt = encryptCallbackPayload(innerXml, "corp1", AES_KEY);
    const envelope = buildWechatXml("xml", {
      ToUserName: "corp1",
      Encrypt: encrypt,
      AgentID: "2",
    });
    const signature = sha1Of(WECOM.tokenSecret, TIMESTAMP, NONCE, encrypt);
    const res = await httpRequest(
      handle.port,
      `/webhook/wechat/wecom-main?msg_signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`,
      { method: "POST", body: envelope },
    );
    // Inner normalization throws the typed malformed-input failure, which the
    // boundary acknowledges (no platform retry) WITHOUT dispatching — the
    // agent binding is never reached with a coerced-to-absent AgentID.
    expect(res).toEqual({ body: "success", status: 200 });
    expect(received).toHaveLength(0);
  });

  it("expires replay entries after the freshness window passes", async () => {
    const received: WechatMessageContext[] = [];
    let now = FIXED_NOW_MS;
    const handle = await startCallbackServer({
      port: 0,
      accounts: [OFFICIAL],
      onMessage: (_id, msg) => {
        received.push(msg);
      },
      clock: { now: () => now },
    });
    closers.push(handle.close);

    const buildBody = (content: string) =>
      buildWechatXml("xml", {
        ToUserName: "gh_app1",
        FromUserName: "openid-alice",
        CreateTime: TIMESTAMP,
        MsgType: "text",
        Content: content,
        MsgId: "6009",
      });
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const path = `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`;

    // First delivery under the triple is accepted.
    expect(
      (
        await httpRequest(handle.port, path, {
          method: "POST",
          body: buildBody("a"),
        })
      ).status,
    ).toBe(200);

    // Different body, same triple: rejected while inside the window.
    expect(
      (
        await httpRequest(handle.port, path, {
          method: "POST",
          body: buildBody("b"),
        })
      ).status,
    ).toBe(403);

    // Advance past the tolerance window: the entry expired, so the map does
    // not grow without bound and a same-triple request is freshness-rejected
    // long before it reaches replay state (403 either way, but the guard's
    // map is empty again — a fresh triple with the same bytes is accepted).
    now = FIXED_NOW_MS + 6 * 60 * 1000;
    const freshTs = String(Math.floor(now / 1000));
    const freshSig = sha1Of(OFFICIAL.tokenSecret, freshTs, NONCE);
    const freshPath = `/webhook/wechat/oa-main?signature=${freshSig}&timestamp=${freshTs}&nonce=${NONCE}`;
    expect(
      (
        await httpRequest(handle.port, freshPath, {
          method: "POST",
          body: buildBody("c"),
        })
      ).status,
    ).toBe(200);
    expect(received).toHaveLength(2);
  });

  it("keeps replay coverage for the full freshness window of a future timestamp", async () => {
    const received: WechatMessageContext[] = [];
    let now = FIXED_NOW_MS;
    const handle = await startCallbackServer({
      port: 0,
      accounts: [OFFICIAL],
      onMessage: (_id, msg) => {
        received.push(msg);
      },
      clock: { now: () => now },
    });
    closers.push(handle.close);

    // Platform clock ~4.5 minutes in the future (still inside the 5-minute
    // freshness window on the receiving side).
    const futureTs = String(Math.floor(FIXED_NOW_MS / 1000) + 270);
    const buildBody = (content: string) =>
      buildWechatXml("xml", {
        ToUserName: "gh_app1",
        FromUserName: "openid-alice",
        CreateTime: futureTs,
        MsgType: "text",
        Content: content,
        MsgId: "6010",
      });
    const signature = sha1Of(OFFICIAL.tokenSecret, futureTs, NONCE);
    const path = `/webhook/wechat/oa-main?signature=${signature}&timestamp=${futureTs}&nonce=${NONCE}`;

    expect(
      (
        await httpRequest(handle.port, path, {
          method: "POST",
          body: buildBody("a"),
        })
      ).status,
    ).toBe(200);

    // Advance 5 minutes: the timestamp is STILL fresh (only ~30s of its
    // skew budget consumed), so a substituted body under the same captured
    // triple must remain rejected — the entry must live until the
    // timestamp's own freshness endpoint, not 5 minutes after receipt.
    now = FIXED_NOW_MS + 5 * 60 * 1000;
    expect(
      (
        await httpRequest(handle.port, path, {
          method: "POST",
          body: buildBody("b"),
        })
      ).status,
    ).toBe(403);
    expect(received).toHaveLength(1);
  });

  it("distinguishes bodies that normalize to the same utf8 string", async () => {
    const received: WechatMessageContext[] = [];
    const handle = await start((_id, msg) => {
      received.push(msg);
    });

    // Two byte sequences that both decode (lossily) to the same utf8 text
    // but are different on the wire: an isolated continuation byte vs the
    // same byte replaced by U+FFFD replacement char encoding.
    const signature = sha1Of(OFFICIAL.tokenSecret, TIMESTAMP, NONCE);
    const path = `/webhook/wechat/oa-main?signature=${signature}&timestamp=${TIMESTAMP}&nonce=${NONCE}`;
    const bodyA = Buffer.from([
      0x3c, 0x78, 0x6d, 0x6c, 0x3e, 0x80, 0x3c, 0x2f, 0x78, 0x6d, 0x6c, 0x3e,
    ]);
    const bodyB = Buffer.from([
      0x3c, 0x78, 0x6d, 0x6c, 0x3e, 0xef, 0xbf, 0xbd, 0x3c, 0x2f, 0x78, 0x6d,
      0x6c, 0x3e,
    ]);
    expect(bodyA.toString("utf8")).toBe(bodyB.toString("utf8"));

    const first = await httpRequestRaw(handle.port, path, bodyA);
    expect(first.status).toBe(200);
    // Same decoded text, different wire bytes: must NOT count as an identical
    // retry of the first delivery.
    const replay = await httpRequestRaw(handle.port, path, bodyB);
    expect(replay.status).toBe(403);
  });
});
