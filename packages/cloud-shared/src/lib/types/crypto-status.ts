/** JSON shape for GET /api/crypto/status (Workers route and dashboard clients). */
export type CryptoStatusTokenKind = "native" | "bep20" | "erc20" | "spl";

export interface CryptoStatusTokenOption {
  symbol: string;
  kind: CryptoStatusTokenKind;
  tokenAddress?: `0x${string}`;
  tokenMint?: string;
  decimals: number;
}

export interface CryptoStatusResponse {
  enabled: boolean;
  oxapayEnabled?: boolean;
  directWallet?: {
    enabled: boolean;
    networks: Array<{
      network: "base" | "bsc" | "solana";
      displayName: string;
      chainId?: number;
      tokenSymbol: string;
      tokenAddress?: `0x${string}`;
      tokenMint?: string;
      tokenDecimals: number;
      tokens: CryptoStatusTokenOption[];
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
