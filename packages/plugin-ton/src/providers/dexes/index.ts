export * from "./torchFinance";
export * from "./dedust";
export * from "./rainbowSwap";
export * from "./stonFi";
export * from "./tonco";
export * from "./dex";

export const SUPPORTED_DEXES = [
    "TORCH_FINANCE",
    "RAINBOW_SWAP",
    "STON_FI",
    "DEDUST",
    "ION_FINANCE",
    "MEGATON_FINANCE",
    "STORM",
    "TRADOOR_IO",
    "TON_HEDGE",
    "TONCO",
];

export const isPoolSupported = (poolName: string) =>
    SUPPORTED_DEXES.includes(poolName);
