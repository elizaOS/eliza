// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
// Shared DLMM module export to avoid bundler issues
import DLMMDefault from "@meteora-ag/dlmm";

export { autoFillYByStrategy, StrategyType } from "@meteora-ag/dlmm";

// Handle both ESM and CommonJS default exports
// @ts-expect-error - TypeScript doesn't understand this pattern
const DLMM = DLMMDefault.default || DLMMDefault;

// Re-export the default as DLMM
export { DLMM };
