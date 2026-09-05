// Pure phone data helpers shared between PhoneView.tsx and phone-interact.ts.
// Kept in a
// non-component module so the .tsx files export only React components and stay
// Fast-Refresh-compatible (Vite full-reloads a component file that also exports
// plain functions).

import type { CallLogEntry } from "@elizaos/capacitor-phone";
import { Phone } from "@elizaos/capacitor-phone";
import { ElizaError } from "@elizaos/core";

const DEFAULT_CALL_LOG_LIMIT = 50;
const MAX_CALL_LOG_LIMIT = 200;
export const COMPLETE_CALL_LOG_READ_LIMIT = 2_147_483_647;

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
  complete?: boolean;
  limit?: unknown;
  number?: string;
}) {
  const normalizedNumber =
    typeof options?.number === "string" ? normalizeNumber(options.number) : "";
  const [status, recent] = await Promise.all([
    Phone.getStatus().catch((cause) => {
      // error-policy:J2 phone status is part of phone-state; a native failure
      // must remain distinct from a valid but unavailable device feature.
      throw new ElizaError("Android phone status is unavailable", {
        code: "NATIVE_PHONE_STATUS_UNAVAILABLE",
        cause,
      });
    }),
    Phone.listRecentCalls({
      limit: options?.complete
        ? COMPLETE_CALL_LOG_READ_LIMIT
        : normalizeCallLogLimit(options?.limit),
      ...(normalizedNumber ? { number: normalizedNumber } : {}),
    }),
  ]);
  return {
    status,
    calls: recent.calls,
  };
}
