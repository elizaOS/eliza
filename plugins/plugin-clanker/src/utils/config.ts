import { ClankerConfig } from "../types";

export function loadClankerConfig(): ClankerConfig {
  return {
    BASE_RPC_URL: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    WALLET_PRIVATE_KEY: process.env.WALLET_PRIVATE_KEY || "",
    CLANKER_API_URL: process.env.CLANKER_API_URL || "",
    DEFAULT_SLIPPAGE: process.env.DEFAULT_SLIPPAGE
      ? parseFloat(process.env.DEFAULT_SLIPPAGE)
      : 0.005,
    MAX_GAS_PRICE: process.env.MAX_GAS_PRICE || "100",
    RETRY_ATTEMPTS: process.env.RETRY_ATTEMPTS
      ? parseInt(process.env.RETRY_ATTEMPTS)
      : 3,
    NETWORK: (process.env.CLANKER_NETWORK as "base" | "base-sepolia") || "base",
  };
}
