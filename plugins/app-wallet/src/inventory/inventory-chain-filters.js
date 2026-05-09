import { resolveChainKey } from "./chainConfig";
const PRIMARY_INVENTORY_CHAIN_KEYS = [
    "ethereum",
    "base",
    "bsc",
    "avax",
    "solana",
];
export const DEFAULT_INVENTORY_CHAIN_FILTERS = {
    ethereum: true,
    base: true,
    bsc: true,
    avax: true,
    solana: true,
};
function isPrimaryInventoryChainKey(k) {
    return PRIMARY_INVENTORY_CHAIN_KEYS.includes(k);
}
export function matchesInventoryChainFilter(chainName, filters) {
    const normalizedFilters = normalizeInventoryChainFilters(filters);
    const k = resolveChainKey(chainName);
    if (!k || !isPrimaryInventoryChainKey(k))
        return false;
    return normalizedFilters[k] === true;
}
/** When exactly one chain is enabled, returns that key; otherwise null. */
export function computeSingleChainFocus(filters) {
    const normalizedFilters = normalizeInventoryChainFilters(filters);
    const enabled = PRIMARY_INVENTORY_CHAIN_KEYS.filter((k) => normalizedFilters[k]);
    return enabled.length === 1 ? enabled[0] : null;
}
export function normalizeInventoryChainFilters(filters) {
    return {
        ...DEFAULT_INVENTORY_CHAIN_FILTERS,
        ...filters,
    };
}
export function toggleInventoryChainFilter(filters, key) {
    const normalizedFilters = normalizeInventoryChainFilters(filters);
    return { ...normalizedFilters, [key]: !normalizedFilters[key] };
}
