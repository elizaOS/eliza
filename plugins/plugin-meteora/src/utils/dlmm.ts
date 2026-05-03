// Shared DLMM module export to avoid bundler issues
import DLMMDefault from "@meteora-ag/dlmm";

export { autoFillYByStrategy, StrategyType } from "@meteora-ag/dlmm";

// Handle both ESM and CommonJS default exports
// @ts-expect-error Interop default shape differs between ESM and CJS builds
const DLMM = DLMMDefault.default || DLMMDefault;

// Re-export the default as DLMM
export { DLMM };
