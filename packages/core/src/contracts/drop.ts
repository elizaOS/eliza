/**
 * Shared drop/mint API contracts.
 */

export interface DropStatus {
  dropEnabled: boolean;
  publicMintOpen: boolean;
  whitelistMintOpen: boolean;
  mintedOut: boolean;
  currentSupply: number;
  maxSupply: number;
  shinyPrice: string;
  userHasMinted: boolean;
}

export interface MintResult {
  agentId: number;
  mintNumber: number;
  txHash: string;
  isShiny: boolean;
}
