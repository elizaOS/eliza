import { randomBytes, timingSafeEqual } from "node:crypto";

import { hashSha256Hex } from "./crypto";
import type { ApiKeyPair } from "./types";

const API_KEY_PREFIX = "stw_";
const API_KEY_HEX_LENGTH = 32;
const API_KEY_BYTES = API_KEY_HEX_LENGTH / 2;

export function generateApiKey(): ApiKeyPair {
  const key = `${API_KEY_PREFIX}${randomBytes(API_KEY_BYTES).toString("hex")}`;

  return {
    key,
    hash: hashApiKey(key),
  };
}

export function hashApiKey(key: string): string {
  return hashSha256Hex(key);
}

export function validateApiKey(key: string, hash: string): boolean {
  const keyHash = hashApiKey(key);
  const keyHashBuffer = Buffer.from(keyHash, "hex");
  const hashBuffer = Buffer.from(hash, "hex");

  if (keyHashBuffer.length !== hashBuffer.length) {
    return false;
  }

  return timingSafeEqual(keyHashBuffer, hashBuffer);
}
