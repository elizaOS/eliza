import { cache } from "@/lib/cache/client";
import { CacheKeys } from "@/lib/cache/keys";

export const APP_AUTH_CODE_TTL_SECONDS = 5 * 60;
const APP_AUTH_CODE_PREFIX = "eac_";

export interface AppAuthCodeRecord {
  appId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

function createOpaqueCode(): string {
  const random = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
  return `${APP_AUTH_CODE_PREFIX}${random}`;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function codeCacheKey(code: string): Promise<string> {
  return CacheKeys.app.authCode(await sha256Hex(code));
}

export function looksLikeAppAuthCode(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(APP_AUTH_CODE_PREFIX);
}

export async function issueAppAuthCode(input: {
  appId: string;
  userId: string;
}): Promise<{ code: string; expiresAt: string; expiresIn: number }> {
  if (!cache.isAvailable()) {
    throw new Error("App auth code store is unavailable");
  }

  const code = createOpaqueCode();
  const now = Date.now();
  const record: AppAuthCodeRecord = {
    appId: input.appId,
    userId: input.userId,
    issuedAt: now,
    expiresAt: now + APP_AUTH_CODE_TTL_SECONDS * 1000,
  };

  const stored = await cache.setIfNotExists(
    await codeCacheKey(code),
    record,
    APP_AUTH_CODE_TTL_SECONDS * 1000,
  );
  if (!stored) {
    throw new Error("App auth code collision");
  }

  return {
    code,
    expiresAt: new Date(record.expiresAt).toISOString(),
    expiresIn: APP_AUTH_CODE_TTL_SECONDS,
  };
}

export async function consumeAppAuthCode(code: string): Promise<AppAuthCodeRecord | null> {
  if (!looksLikeAppAuthCode(code)) return null;

  const record = await cache.getAndDelete<AppAuthCodeRecord>(await codeCacheKey(code));
  if (!record || record.expiresAt <= Date.now()) return null;
  return record;
}
