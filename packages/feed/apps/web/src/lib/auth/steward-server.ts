/**
 * Shared server-side Steward configuration and utilities.
 *
 * Centralizes the JWT secret, API URL, and platform key so that
 * farcaster/route.ts, telegram-miniapp/route.ts, and session/route.ts
 * all use the same values and production-guard logic.
 */

/**
 * Returns the Steward JWT signing secret as a Uint8Array.
 * Throws in production when STEWARD_JWT_SECRET is missing.
 * Falls back to a clearly-named dev secret in non-production environments.
 */
export function getStewardJwtSecret(): Uint8Array {
  const secret = process.env.STEWARD_JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('STEWARD_JWT_SECRET is required in production');
    }
    return new TextEncoder().encode('dev-jwt-secret-change-in-prod');
  }
  return new TextEncoder().encode(secret);
}

/** Steward internal API base URL. */
export const STEWARD_API_URL =
  process.env.STEWARD_API_URL ?? 'http://localhost:3200';

/** First platform key from the comma-separated STEWARD_PLATFORM_KEYS list. */
export const STEWARD_PLATFORM_KEY =
  (process.env.STEWARD_PLATFORM_KEYS ?? '').split(',')[0]?.trim() ?? '';

/**
 * Provision a Steward user record by email (idempotent).
 * Falls back to a random UUID if no email or platform key is available
 * (development / Farcaster/Telegram users without email).
 */
export async function ensureStewardUser(email?: string): Promise<string> {
  if (!email || !STEWARD_PLATFORM_KEY) return crypto.randomUUID();

  const res = await fetch(`${STEWARD_API_URL}/platform/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Steward-Platform-Key': STEWARD_PLATFORM_KEY,
    },
    body: JSON.stringify({ email, emailVerified: false }),
  });

  if (!res.ok)
    throw new Error(`Failed to provision Steward user: ${res.status}`);

  const data = (await res.json()) as {
    ok: boolean;
    data?: { userId?: string };
    error?: string;
  };

  if (!data.ok || !data.data?.userId)
    throw new Error(data.error ?? 'Steward provisioning: missing userId');

  return data.data.userId;
}
