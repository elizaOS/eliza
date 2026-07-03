export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
export const HYPERLIQUID_EXECUTION_BLOCKED_REASON = "Signed Hyperliquid exchange mutations are disabled until the native app has a real managed or local execution path.";
export const HYPERLIQUID_EXECUTION_NOT_IMPLEMENTED_REASON = "A signer is available, but signed Hyperliquid exchange execution remains disabled in this native app.";
export const HYPERLIQUID_ACCOUNT_BLOCKED_REASON = "Connect a managed Eliza Cloud vault or set HYPERLIQUID_ACCOUNT_ADDRESS / HL_ACCOUNT_ADDRESS to read account-specific positions and orders.";
export const HYPERLIQUID_VAULT_GUIDANCE = "Connect Eliza Cloud or Steward to use a managed vault. Public market reads do not require a vault.";
export const HYPERLIQUID_LOCAL_KEY_GUIDANCE = "Advanced optional path: set EVM_PRIVATE_KEY, HYPERLIQUID_PRIVATE_KEY, or HL_PRIVATE_KEY only when running a local signer intentionally. Public market reads do not require local keys.";
export const HYPERLIQUID_API_WALLET_GUIDANCE = "Optional Hyperliquid API-wallet delegation uses HYPERLIQUID_AGENT_KEY or HL_AGENT_KEY after a managed vault or local signer exists. It is not required for public reads.";
//# sourceMappingURL=hyperliquid-contracts.js.map