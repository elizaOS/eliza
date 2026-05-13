// Shared DLMM module export to avoid bundler issues
import DLMMDefault, { autoFillYByStrategy, StrategyType } from "@meteora-ag/dlmm";

export type { LbPosition } from "@meteora-ag/dlmm";
export { autoFillYByStrategy, StrategyType };

type DLMMConstructor = typeof DLMMDefault;
type DLMMModule = DLMMConstructor | { default: DLMMConstructor };

// Handle both ESM and CommonJS default exports
const dlmmModule = DLMMDefault as DLMMModule;
const DLMM: DLMMConstructor = "default" in dlmmModule ? dlmmModule.default : dlmmModule;

// Re-export the default as DLMM
export { DLMM };
