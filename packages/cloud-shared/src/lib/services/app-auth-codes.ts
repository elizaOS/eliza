import { appAuthCodesRepository } from "@/db/repositories/app-auth-codes";

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

export function looksLikeAppAuthCode(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith(APP_AUTH_CODE_PREFIX);
}

export async function issueAppAuthCode(input: {
  appId: string;
  userId: string;
}): Promise<{ code: string; expiresAt: string; expiresIn: number }> {
  const code = createOpaqueCode();
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + APP_AUTH_CODE_TTL_SECONDS * 1000);

  await appAuthCodesRepository.create({
    code_hash: await sha256Hex(code),
    app_id: input.appId,
    user_id: input.userId,
    issued_at: issuedAt,
    expires_at: expiresAt,
  });

  return {
    code,
    expiresAt: expiresAt.toISOString(),
    expiresIn: APP_AUTH_CODE_TTL_SECONDS,
  };
}

export async function consumeAppAuthCode(code: string): Promise<AppAuthCodeRecord | null> {
  if (!looksLikeAppAuthCode(code)) return null;

  const row = await appAuthCodesRepository.consume(await sha256Hex(code));
  if (!row) return null;

  return {
    appId: row.app_id,
    userId: row.user_id,
    issuedAt: row.issued_at.getTime(),
    expiresAt: row.expires_at.getTime(),
  };
}
