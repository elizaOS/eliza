import type { InventoryChainFilters } from "@elizaos/ui";
import type { ChainKey } from "./chainConfig.ts";
import { resolveChainKey } from "./chainConfig.ts";

export type PrimaryInventoryChainKey = keyof InventoryChainFilters;

const PRIMARY_INVENTORY_CHAIN_KEYS = [
  "ethereum",
  "base",
  "bsc",
  "avax",
  "solana",
] as const satisfies readonly PrimaryInventoryChainKey[];

export const DEFAULT_INVENTORY_CHAIN_FILTERS: InventoryChainFilters = {
  ethereum: true,
  base: true,
  bsc: true,
  avax: true,
  solana: true,
};

type InventoryChainFilterState =
  | InventoryChainFilters
  | Partial<InventoryChainFilters>
  | null
  | undefined;
function isPrimaryInventoryChainKey(
  k: ChainKey,
): k is PrimaryInventoryChainKey {
  return PRIMARY_INVENTORY_CHAIN_KEYS.includes(k as PrimaryInventoryChainKey);
}

export function matchesInventoryChainFilter(
  chainName: string,
  filters: InventoryChainFilterState,
): boolean {
  const normalizedFilters = normalizeInventoryChainFilters(filters);
  const k = resolveChainKey(chainName);
  if (!k || !isPrimaryInventoryChainKey(k)) return false;
  return normalizedFilters[k] === true;
}

/** When exactly one chain is enabled, returns that key; otherwise null. */
export function computeSingleChainFocus(
  filters: InventoryChainFilterState,
): PrimaryInventoryChainKey | null {
  const normalizedFilters = normalizeInventoryChainFilters(filters);
  const enabled = PRIMARY_INVENTORY_CHAIN_KEYS.filter(
    (k) => normalizedFilters[k],
  );
  return enabled.length === 1 ? enabled[0] : null;
}

export function normalizeInventoryChainFilters(
  filters: InventoryChainFilterState,
): InventoryChainFilters {
  return {
    ...DEFAULT_INVENTORY_CHAIN_FILTERS,
    ...filters,
  };
}

export function toggleInventoryChainFilter(
  filters: InventoryChainFilterState,
  key: PrimaryInventoryChainKey,
): InventoryChainFilters {
  const normalizedFilters = normalizeInventoryChainFilters(filters);
  return { ...normalizedFilters, [key]: !normalizedFilters[key] };
}
