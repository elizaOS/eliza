/** JSON shape for GET /api/crypto/status (Workers route and dashboard clients). */
export interface CryptoStatusResponse {
  enabled: boolean;
  oxapayEnabled?: boolean;
  directWallet?: {
    enabled: boolean;
    networks: Array<{
      network: "base" | "bsc" | "solana";
      displayName: string;
      chainId?: number;
      tokenSymbol: "USDC" | "USDT";
      tokenAddress?: `0x${string}`;
      tokenMint?: string;
      tokenDecimals: number;
      receiveAddress: string | null;
      enabled: boolean;
    }>;
    promotion: {
      code: "bsc";
      network: "bsc";
      minimumUsd: number;
      bonusCredits: number;
    };
  };
  supportedTokens: string[];
  networks: Array<{ id: string; name: string }>;
  isTestnet: boolean;
}
