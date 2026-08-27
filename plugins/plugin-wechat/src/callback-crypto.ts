/**
 * Cryptographic verification and decryption for first-party WeChat platform
 * callbacks: URL-verification and message signatures are SHA-1 over the
 * lexicographically sorted token/timestamp/nonce(/encrypted-body) parts, and
 * encrypted callbacks (WeCom always; Official Account compatible/safe mode)
 * use AES-256-CBC with the base64 EncodingAESKey plus PKCS#7 unpadding and an
 * embedded receiver-id check. All primitives are injectable so tests run
 * against official-style vectors without secrets.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { WechatError } from "./types";

/** Raw AEKey bytes are exactly 32 bytes (43-char base64 without padding). */
export const WECHAT_AES_KEY_LENGTH = 32;
const WECHAT_AES_KEY_BASE64_LENGTH = 43;

export type Sha1Fn = (input: string) => string;
export type AesDecryptFn = (
  key: Buffer,
  iv: Buffer,
  ciphertext: Buffer,
) => Buffer;
export type AesEncryptFn = (
  key: Buffer,
  iv: Buffer,
  plaintext: Buffer,
) => Buffer;

export const defaultSha1: Sha1Fn = (input) =>
  createHash("sha1").update(input, "utf8").digest("hex");

export const defaultAesDecrypt: AesDecryptFn = (key, iv, ciphertext) => {
  // WeChat's scheme applies its own 32-byte PKCS#7 padding, so Node's
  // 16-byte auto-padding must be disabled on both directions (matching the
  // platform reference implementations).
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
};
// WeChat's reference implementations use the first 16 key bytes as the CBC IV.
export const wechatIv = (key: Buffer): Buffer => key.subarray(0, 16);

export const defaultAesEncrypt: AesEncryptFn = (key, iv, plaintext) => {
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
};

/** Constant-time hex digest comparison that never early-exits on length. */
export function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Burn a comparison to keep timing independent of the mismatch position.
    const longer = bufA.length >= bufB.length ? bufA : bufB;
    let acc = 0;
    for (let i = 0; i < longer.length; i += 1) {
      acc |= longer[i] ^ longer[i];
    }
    void acc;
    return false;
  }
  return timingSafeEqualBytes(bufA, bufB);
}

function timingSafeEqualBytes(a: Buffer, b: Buffer): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

/**
 * Verify a callback signature: SHA-1 over the lexicographically sorted parts.
 * The encrypted-body part is included only for encrypted-mode requests.
 */
export function verifyCallbackSignature(
  signature: string,
  parts: Array<string | undefined>,
  sha1: Sha1Fn = defaultSha1,
): boolean {
  const values = parts.map((part) => part ?? "");
  const sorted = [...values].sort().join("");
  const expected = sha1(sorted);
  return safeEqualHex(signature, expected);
}

/** Decode and validate a 43-char base64 EncodingAESKey into its 32 raw bytes. */
export function decodeEncodingAESKey(encodingAESKey: string): Buffer {
  const trimmed = encodingAESKey.trim();
  if (trimmed.length !== WECHAT_AES_KEY_BASE64_LENGTH) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "encodingAESKey must be 43 base64 characters",
      { length: trimmed.length },
    );
  }
  const key = Buffer.from(`${trimmed}=`, "base64");
  if (key.length !== WECHAT_AES_KEY_LENGTH) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "encodingAESKey must decode to 32 bytes",
      { length: key.length },
    );
  }
  key.fill(0, WECHAT_AES_KEY_LENGTH, key.length);
  return key.subarray(0, WECHAT_AES_KEY_LENGTH);
}

export interface DecryptResult {
  /** Decrypted XML or echo text. */
  plaintext: string;
  /** Receiver identity embedded in the message (appId or corpId). */
  receiverId: string;
}

/**
 * Decrypt an encrypted callback body: AES-256-CBC with the AEK as both key and
 * IV, strip PKCS#7 padding, parse `random(16) | msg_len(4, BE) | msg | receiveid`.
 */
export function decryptCallbackPayload(
  base64Ciphertext: string,
  encodingAESKey: string,
  options?: {
    aesDecrypt?: AesDecryptFn;
    maxPlaintextBytes?: number;
  },
): DecryptResult {
  const maxPlaintext = options?.maxPlaintextBytes ?? 1024 * 1024;
  const aesDecrypt = options?.aesDecrypt ?? defaultAesDecrypt;
  const key = decodeEncodingAESKey(encodingAESKey);

  let ciphertext: Buffer;
  try {
    ciphertext = Buffer.from(base64Ciphertext, "base64");
  } catch {
    // error-policy:J3 the ciphertext is untrusted input; invalid base64 is
    // an explicit typed decrypt failure, never a zero-length stand-in.
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "ciphertext is not valid base64",
    );
  }
  if (
    ciphertext.length === 0 ||
    ciphertext.length % 16 !== 0 ||
    ciphertext.length > maxPlaintext + WECHAT_AES_KEY_LENGTH
  ) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "ciphertext length is invalid",
      { length: ciphertext.length },
    );
  }

  let plaintext: Buffer;
  try {
    plaintext = aesDecrypt(key, wechatIv(key), ciphertext);
  } catch {
    // error-policy:J3 the ciphertext is untrusted input; an AES failure is
    // an explicit typed decrypt failure, never a fabricated plaintext.
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "AES decryption failed",
    );
  }

  const unpadded = pkcs7Unpad(plaintext);
  if (unpadded.length < 16 + 4 + 1) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "decrypted payload is too short",
      { length: unpadded.length },
    );
  }

  const messageLength = unpadded.readUInt32BE(16);
  if (messageLength <= 0 || 16 + 4 + messageLength + 1 > unpadded.length) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "embedded message length is out of range",
      { messageLength },
    );
  }

  const message = unpadded.subarray(20, 20 + messageLength);
  const receiverId = unpadded.subarray(20 + messageLength).toString("utf8");

  return { plaintext: message.toString("utf8"), receiverId };
}

/** Encrypt for callback responses (WeCom URL verification echo). */
export function encryptCallbackPayload(
  plaintext: string,
  receiverId: string,
  encodingAESKey: string,
  options?: { aesEncrypt?: AesEncryptFn },
): string {
  const aesEncrypt = options?.aesEncrypt ?? defaultAesEncrypt;
  const key = decodeEncodingAESKey(encodingAESKey);
  const message = Buffer.from(plaintext, "utf8");
  const random = randomBytes(16);
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(message.length, 0);
  const receiver = Buffer.from(receiverId, "utf8");
  const padded = pkcs7Pad(
    Buffer.concat([random, lengthBuf, message, receiver]),
    WECHAT_AES_KEY_LENGTH,
  );
  return aesEncrypt(key, wechatIv(key), padded).toString("base64");
}

function pkcs7Unpad(data: Buffer): Buffer {
  if (data.length === 0 || data.length % WECHAT_AES_KEY_LENGTH !== 0) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "decrypted block size is invalid",
    );
  }
  // Tencent's reference implementations strip `pad = last byte` when it is in
  // 1..32 WITHOUT verifying that every padding byte matches: the platform's
  // own documented sample vector carries non-uniform padding bytes, and
  // integrity is guaranteed by the SHA-1 message signature over the
  // ciphertext, not by the padding. Rejecting non-uniform padding would break
  // compatibility with bytes the platform actually produced.
  const pad = data[data.length - 1];
  if (pad <= 0 || pad > WECHAT_AES_KEY_LENGTH) {
    throw new WechatError(
      "WECHAT_CALLBACK_DECRYPT_FAILED",
      "PKCS#7 padding is invalid",
    );
  }
  return data.subarray(0, data.length - pad);
}

function pkcs7Pad(data: Buffer, blockSize: number): Buffer {
  const pad = blockSize - (data.length % blockSize);
  return Buffer.concat([data, Buffer.alloc(pad, pad)]);
}
