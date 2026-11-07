import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export interface TelegramLoginPayload {
  id?: unknown;
  first_name?: unknown;
  last_name?: unknown;
  username?: unknown;
  photo_url?: unknown;
  auth_date?: unknown;
  hash?: unknown;
  [key: string]: unknown;
}

export interface VerifiedTelegramUser {
  id: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  photoUrl?: string;
  authDate: number;
}

export interface VerifyTelegramLoginOptions {
  nowMs?: number;
  maxAgeSec?: number;
  maxFutureSkewSec?: number;
}

const DEFAULT_MAX_AGE_SEC = 24 * 60 * 60;
const DEFAULT_MAX_FUTURE_SKEW_SEC = 5 * 60;
const TELEGRAM_HASH_RE = /^[0-9a-f]{64}$/i;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value))
    return String(Math.trunc(value));
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function telegramLoginDataCheckString(
  payload: TelegramLoginPayload,
): string {
  return Object.entries(payload)
    .filter(
      ([key, value]) => key !== "hash" && value !== undefined && value !== null,
    )
    .map(([key, value]) => [key, String(value)] as const)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function signTelegramLoginPayload(
  payload: Omit<TelegramLoginPayload, "hash">,
  botToken: string,
): string {
  const secretKey = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secretKey)
    .update(telegramLoginDataCheckString(payload))
    .digest("hex");
}

export function verifyTelegramLogin(
  payload: TelegramLoginPayload,
  botToken: string,
  options: VerifyTelegramLoginOptions = {},
): VerifiedTelegramUser {
  if (!botToken.trim()) throw new Error("Telegram bot token is required");
  const id = asNonEmptyString(payload.id);
  if (!id || !/^\d+$/.test(id)) throw new Error("Telegram id is required");
  const authDateRaw = asNonEmptyString(payload.auth_date);
  const authDate = authDateRaw ? Number(authDateRaw) : NaN;
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw new Error("Telegram auth_date is required");
  }
  const hash = asNonEmptyString(payload.hash);
  if (!hash || !TELEGRAM_HASH_RE.test(hash))
    throw new Error("Telegram hash is required");

  const expected = signTelegramLoginPayload(
    { ...payload, hash: undefined },
    botToken,
  );
  const providedHash = Buffer.from(hash.toLowerCase(), "hex");
  const expectedHash = Buffer.from(expected, "hex");
  if (
    providedHash.length !== expectedHash.length ||
    !timingSafeEqual(providedHash, expectedHash)
  ) {
    throw new Error("Telegram login hash mismatch");
  }

  const nowMs = options.nowMs ?? Date.now();
  const maxAgeSec = options.maxAgeSec ?? DEFAULT_MAX_AGE_SEC;
  const nowSec = Math.floor(nowMs / 1000);
  const maxFutureSkewSec =
    options.maxFutureSkewSec ?? DEFAULT_MAX_FUTURE_SKEW_SEC;
  if (authDate - nowSec > maxFutureSkewSec) {
    throw new Error("Telegram login payload is from the future");
  }
  if (nowSec - authDate > maxAgeSec) {
    throw new Error("Telegram login payload is expired");
  }

  return {
    id,
    firstName: optionalString(payload.first_name),
    lastName: optionalString(payload.last_name),
    username: optionalString(payload.username),
    photoUrl: optionalString(payload.photo_url),
    authDate,
  };
}
