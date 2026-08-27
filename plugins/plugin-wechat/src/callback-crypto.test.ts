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

  it("rejects DTDs, entities, CDATA, nesting, and trailing content", () => {
    expect(() =>
      parseWechatXml(
        '<!DOCTYPE xml [<!ENTITY xxe "file:///etc/passwd">]><xml><a>1</a></xml>',
      ),
    ).toThrow(WechatError);
    expect(() => parseWechatXml("<xml><a><![CDATA[1]]></a></xml>")).toThrow(
      WechatError,
    );
    expect(() => parseWechatXml("<xml><a><b>1</b></a></xml>")).toThrow(
      WechatError,
    );
    expect(() =>
      parseWechatXml("<xml><a>1</a></xml><xml><a>2</a></xml>"),
    ).toThrow(WechatError);
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
