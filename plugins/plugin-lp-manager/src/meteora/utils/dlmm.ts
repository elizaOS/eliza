// Shared DLMM module export to avoid bundler issues
import DLMMDefault from '@meteora-ag/dlmm';
export { StrategyType, autoFillYByStrategy } from '@meteora-ag/dlmm';

// Handle both ESM and CommonJS default exports
// @ts-ignore - TypeScript doesn't understand this pattern
const DLMM = DLMMDefault.default || DLMMDefault;

// Re-export the default as DLMM
export { DLMM }; 