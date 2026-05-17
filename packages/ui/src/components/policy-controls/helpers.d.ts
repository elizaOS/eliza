import type { ApprovedAddressEntry, PolicyRule, PolicyType } from "./types";
export declare function findPolicy(
  policies: PolicyRule[],
  type: PolicyType,
): PolicyRule | undefined;
/** Parse a numeric string (USD amount). Returns 0 for invalid input. */
export declare function parseAmount(value: string): number;
export declare function formatHour(h: number): string;
/** Validate an address (EVM or Solana). */
export declare function isValidAddress(addr: string): boolean;
/** Detect chain type from address format. */
export declare function detectChainType(addr: string): "evm" | "solana" | null;
/** Format a chain type label for display. */
export declare function chainTypeLabel(addr: string): string;
export declare function approvedAddressValue(
  entry: string | ApprovedAddressEntry,
): string;
//# sourceMappingURL=helpers.d.ts.map
