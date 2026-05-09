import type { ApprovedAddressEntry, PolicyRule, PolicyType } from "./types";

export function findPolicy(
  policies: PolicyRule[],
  type: PolicyType,
): PolicyRule | undefined {
  return policies.find((p) => p.type === type);
}

/** Parse a numeric string (USD amount). Returns 0 for invalid input. */
export function parseAmount(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isNaN(n) ? 0 : n;
}

export function formatHour(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h === 12) return "12:00 PM";
  if (h < 12) return `${h}:00 AM`;
  return `${h - 12}:00 PM`;
}

const EVM_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Validate an address (EVM or Solana). */
export function isValidAddress(addr: string): boolean {
  return EVM_RE.test(addr) || SOLANA_RE.test(addr);
}

/** Detect chain type from address format. */
export function detectChainType(addr: string): "evm" | "solana" | null {
  if (EVM_RE.test(addr)) return "evm";
  if (SOLANA_RE.test(addr)) return "solana";
  return null;
}

/** Format a chain type label for display. */
export function chainTypeLabel(addr: string): string {
  const type = detectChainType(addr);
  if (type === "evm") return "EVM";
  if (type === "solana") return "Solana";
  return "";
}

export function approvedAddressValue(
  entry: string | ApprovedAddressEntry,
): string {
  return typeof entry === "string" ? entry : entry.address;
}
