import "./core-augmentation.js";

export { agentWalletPlugin } from "./plugin.js";
export { default } from "./plugin.js";

export * from "./wallet/index.js";
export * from "./actions/index.js";
export * from "./providers/canonical-provider.js";
export * from "./policy/policy.js";
export * from "./audit/audit-log.js";
export { WalletBackendService } from "./services/wallet-backend-service.js";
export { unifiedWalletProvider } from "./providers/unified-wallet-provider.js";

/** ERC-6551 / x402 / CCTP / swaps live under `import "@elizaos/plugin-agent-wallet/sdk"`. */
