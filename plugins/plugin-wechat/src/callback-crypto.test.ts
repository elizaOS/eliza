/**
 * Cryptographic and XML-boundary coverage for the direct first-party callback
 * path: SHA-1 signature verification against independently computed digests,
 * official-style AES-256-CBC + PKCS#7 + receiver-id round trips, key-length
 * rejection, and hardened-XML parse behavior on malformed/hostile documents.
 * All crypto primitives under test are the real node:crypto implementations.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCallbackPayload,
  encryptCallbackPayload,
  verifyCallbackSignature,
} from "./callback-crypto";
import { WechatError } from "./types";
import { buildWechatXml, parseWechatXml } from "./xml";

const TOKEN = "callback-token";
const TIMESTAMP = "1710969600";
const NONCE = "nonce-42";

function sha1Of(...parts: string[]): string {
  return createHash("sha1")
    .update([...parts].sort().join(""), "utf8")
    .digest("hex");
}

describe("verifyCallbackSignature", () => {
  it("accepts a correctly computed plaintext signature", () => {
    const signature = sha1Of(TOKEN, TIMESTAMP, NONCE);
    expect(verifyCallbackSignature(signature, [TOKEN, TIMESTAMP, NONCE])).toBe(
      true,
    );
  });

  it("accepts a correctly computed encrypted-mode signature including the body", () => {
    const encrypt = "some-ciphertext";
    const signature = sha1Of(TOKEN, TIMESTAMP, NONCE, encrypt);
    expect(
      verifyCallbackSignature(signature, [TOKEN, TIMESTAMP, NONCE, encrypt]),
    ).toBe(true);
  });

  it("rejects a wrong signature, wrong token, and reordered inputs", () => {
    const signature = sha1Of(TOKEN, TIMESTAMP, NONCE);
    expect(verifyCallbackSignature("deadbeef", [TOKEN, TIMESTAMP, NONCE])).toBe(
      false,
    );
    expect(
      verifyCallbackSignature(signature, ["other-token", TIMESTAMP, NONCE]),
    ).toBe(false);
    // Sorting is over the values; feeding an extra value changes the digest.
    expect(
      verifyCallbackSignature(signature, [TOKEN, TIMESTAMP, NONCE, "extra"]),
    ).toBe(false);
  });

  it("rejects missing parts as empty strings", () => {
    const signature = sha1Of(TOKEN, TIMESTAMP, NONCE);
    expect(verifyCallbackSignature(signature, [TOKEN, TIMESTAMP])).toBe(false);
  });
});

describe("callback AES crypto", () => {
  // Any 43-char base64 body decoding to 32 bytes works.
  const aesKey = Buffer.from("0123456789abcdef0123456789abcdef")
    .toString("base64")
    .replace(/=+$/, "")
    .slice(0, 43)
    .padEnd(43, "A");

  it("round-trips an encrypted callback and preserves the receiver id", () => {
    const xml = buildWechatXml("xml", {
      ToUserName: "gh_app",
      FromUserName: "openid-alice",
      MsgType: "text",
      Content: "你好 🦊",
      MsgId: "12345",
    });
    const ciphertext = encryptCallbackPayload(xml, "gh_app", aesKey);
    const decrypted = decryptCallbackPayload(ciphertext, aesKey);
    expect(decrypted.receiverId).toBe("gh_app");
    expect(decrypted.plaintext).toBe(xml);
  });

  it("rejects a ciphertext signed/encrypted for another account's key", () => {
    const otherKey = Buffer.from("fedcba9876543210fedcba9876543210")
      .toString("base64")
      .replace(/=+$/, "")
      .slice(0, 43)
      .padEnd(43, "B");
    const ciphertext = encryptCallbackPayload("<xml/>", "gh_other", otherKey);
    expect(() => decryptCallbackPayload(ciphertext, aesKey)).toThrow(
      WechatError,
    );
  });

  it("rejects malformed keys and payloads", () => {
    expect(() => decryptCallbackPayload("x", "short")).toThrow(WechatError);
    expect(() => decryptCallbackPayload("!!!not-base64!!!", aesKey)).toThrow(
      WechatError,
    );
    expect(() => decryptCallbackPayload("", aesKey)).toThrow(WechatError);
  });
});

describe("parseWechatXml hardening", () => {
  const valid = buildWechatXml("xml", {
    ToUserName: "gh_app",
    FromUserName: "openid-alice",
    MsgType: "text",
    Content: "hello & <world>",
    MsgId: "1",
  });

  it("parses a flat document and decodes entities once", () => {
    const parsed = parseWechatXml(valid);
    expect(parsed.root).toBe("xml");
    expect(parsed.fields.Content).toBe("hello & <world>");
    expect(parsed.fields.FromUserName).toBe("openid-alice");
  });

  it("parses CDATA-wrapped leaf values as the platforms emit them", () => {
    const parsed = parseWechatXml(
      "<xml><ToUserName><![CDATA[gh_123]]></ToUserName><Content><![CDATA[a ]x> b &amp; c]]></Content></xml>",
    );
    expect(parsed.fields.ToUserName).toBe("gh_123");
    // CDATA content is verbatim character data: entity references inside
    // CDATA are literal text, not markup, and are not decoded.
    expect(parsed.fields.Content).toBe("a ]x> b &amp; c");
  });

  it("does not treat a literal root close inside CDATA as markup", () => {
    const parsed = parseWechatXml(
      "<xml><Content><![CDATA[pre </xml> post]]></Content><MsgId>1</MsgId></xml>",
    );
    expect(parsed.fields.Content).toBe("pre </xml> post");
    expect(parsed.fields.MsgId).toBe("1");
  });

  it("rejects unterminated CDATA sections", () => {
    expect(() => parseWechatXml("<xml><a><![CDATA[unclosed</a></xml>")).toThrow(
      WechatError,
    );
  });

  it("rejects DTDs, entities, nesting, and trailing content", () => {
    expect(() =>
      parseWechatXml(
        '<!DOCTYPE xml [<!ENTITY xxe "file:///etc/passwd">]><xml><a>1</a></xml>',
      ),
    ).toThrow(WechatError);
    expect(() => parseWechatXml("<xml><a><b>1</b></a></xml>")).toThrow(
      WechatError,
    );
    expect(() =>
      parseWechatXml("<xml><a>1</a></xml><xml><a>2</a></xml>"),
    ).toThrow(WechatError);
  });

  it("decrypts Tencent's official WeCom sample ciphertext with 32-byte PKCS#7", () => {
    // Vector from Tencent's WXBizMsgCrypt documentation sample: the famous
    // wx5823bf96d3bd56c7 callback. Key jWmYm7...; pad byte 30; receiver
    // wx5823bf96d3bd56R4; inner XML carries CDATA-wrapped fields and AgentID.
    const result = decryptCallbackPayload(
      "RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe1lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==",
      "jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C",
    );
    expect(result.receiverId).toBe("wx5823bf96d3bd56R4");
    const parsed = parseWechatXml(result.plaintext);
    expect(parsed.fields.ToUserName).toBe("wx5823bf96d3bd56c7");
    expect(parsed.fields.FromUserName).toBe("mycreate");
    expect(parsed.fields.Content).toBe("hello");
    expect(parsed.fields.AgentID).toBe("218");
  });

  it("rejects oversized documents under the byte cap", () => {
    const big = `<xml><a>${"x".repeat(200_000)}</a></xml>`;
    expect(() => parseWechatXml(big)).toThrow(WechatError);
  });

  it("keeps self-closing children as empty values", () => {
    const parsed = parseWechatXml("<xml><a/></xml>");
    expect(parsed.fields.a).toBe("");
  });
});
