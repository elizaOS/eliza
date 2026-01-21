export const CHAIN_NAMES: Record<number, string> = {
  31337: "Local",
  84532: "Base Sepolia",
  8453: "Base",
  1: "Ethereum",
  11155111: "Sepolia",
};

export function getChainName(chainId: number): string {
  return CHAIN_NAMES[chainId] || `Chain ${chainId}`;
}
