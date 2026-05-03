/** JSON shape for GET /api/crypto/status (Workers route and dashboard clients). */
export interface CryptoStatusResponse {
  enabled: boolean;
  supportedTokens: string[];
  networks: Array<{ id: string; name: string }>;
  isTestnet: boolean;
}
