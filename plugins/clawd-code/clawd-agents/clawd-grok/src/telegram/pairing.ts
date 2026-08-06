import { randomBytes } from "node:crypto";

const PAIRING_TTL_MS = 60 * 60 * 1000;

/** code (uppercase) -> { userId, expiresAt } */
const pendingByCode = new Map<string, { userId: number; expiresAt: number }>();

function generateCode(): string {
  const hex = randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
  return hex;
}

export function registerPairingCode(userId: number): string {
  const code = generateCode();
  pendingByCode.set(code, { userId, expiresAt: Date.now() + PAIRING_TTL_MS });
  return code;
}

export function approvePairingCode(code: string): { ok: true; userId: number } | { ok: false; error: string } {
  const normalized = code.trim().toUpperCase();
  const entry = pendingByCode.get(normalized);
  if (!entry) {
    return { ok: false, error: "Unknown or expired code." };
  }
  if (Date.now() > entry.expiresAt) {
    pendingByCode.delete(normalized);
    return { ok: false, error: "Code expired. Send /pair again in Telegram." };
  }
  pendingByCode.delete(normalized);
  return { ok: true, userId: entry.userId };
}

export function clearPairingStore(): void {
  pendingByCode.clear();
}
