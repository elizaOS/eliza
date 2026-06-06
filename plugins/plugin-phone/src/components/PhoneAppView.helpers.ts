// Pure phone data helpers shared between PhoneAppView.tsx (the React views) and
// PhoneAppView.interact.ts (the terminal capability handler). Split out so the
// .tsx file exports only React components and stays Fast-Refresh-compatible
// (Vite full-reloads a component file that also exports plain functions).

import type { CallLogEntry } from "@elizaos/capacitor-phone";
import { Phone } from "@elizaos/capacitor-phone";

const DEFAULT_CALL_LOG_LIMIT = 50;
const MAX_CALL_LOG_LIMIT = 200;

export function callLabelFor(entry: CallLogEntry): string {
  if (entry.cachedName && entry.cachedName.trim().length > 0) {
    return entry.cachedName.trim();
  }
  if (entry.number && entry.number.trim().length > 0) {
    return entry.number.trim();
  }
  return "Unknown";
}

/** Strip whitespace and visual separators while keeping leading + and digits. */
export function normalizeNumber(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  const leadingPlus = trimmed.startsWith("+") ? "+" : "";
  return `${leadingPlus}${trimmed.replace(/[^0-9]/g, "")}`;
}

function normalizeCallLogLimit(limit: unknown): number {
  if (!Number.isFinite(limit) || typeof limit !== "number") {
    return DEFAULT_CALL_LOG_LIMIT;
  }
  return Math.min(MAX_CALL_LOG_LIMIT, Math.max(1, Math.trunc(limit)));
}

export async function loadPhoneState(options?: {
  limit?: unknown;
  number?: string;
}) {
  const normalizedNumber =
    typeof options?.number === "string" ? normalizeNumber(options.number) : "";
  const [status, recent] = await Promise.all([
    Phone.getStatus().catch(() => null),
    Phone.listRecentCalls({
      limit: normalizeCallLogLimit(options?.limit),
      ...(normalizedNumber ? { number: normalizedNumber } : {}),
    }),
  ]);
  return {
    status,
    calls: recent.calls,
  };
}
