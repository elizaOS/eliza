// [MAX-ADDED] x402 Protocol Module — HTTP 402 payment support for AgentWallet

export { X402BudgetTracker } from "./budget.js";
export type {
  AbstractDelegatedPaymentConfig,
  AbstractPaymentResult,
  DelegatedPaymentPermit,
} from "./chains/abstract/index.js";
// ─── Chain-Specific Adapters ──────────────────────────────────────────────────
export {
  ABSTRACT_APPROVED_FACILITATORS,
  ABSTRACT_CHAIN_IDS,
  ABSTRACT_SUPPORTED_CHAINS,
  ABSTRACT_USDC,
  AbstractDelegatedFacilitatorAdapter,
} from "./chains/abstract/index.js";
export {
  X402BudgetExceededError,
  X402Client,
  X402PaymentError,
} from "./client.js";
export {
  createX402Client,
  createX402Fetch,
  wrapWithX402,
} from "./middleware.js";

// v6: Multi-asset resolution utilities
export {
  buildSupportedAssets,
  isStablecoin,
  parseNetworkChainId,
  resolveAssetAddress,
  resolveAssetDecimals,
} from "./multi-asset.js";
export type {
  X402ClientConfig,
  X402PaymentPayload,
  X402PaymentRequired,
  X402PaymentRequirements,
  X402ResourceInfo,
  X402ServiceBudget,
  X402SettlementResponse,
  X402TransactionLog,
} from "./types.js";
export { DEFAULT_SUPPORTED_NETWORKS, USDC_ADDRESSES } from "./types.js";
