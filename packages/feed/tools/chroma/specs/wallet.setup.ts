/**
 * Wallet constants for E2E tests
 *
 * Provides wallet and network configuration used across test files.
 * MetaMask setup (import mnemonic, add network) is handled by
 * Chroma's wallet fixtures at test time.
 */

/**
 * Default Anvil test wallet configuration
 * Account #0 from 'test test test test test test test test test test test junk'
 */
export const ANVIL_WALLET = {
  seedPhrase: 'test test test test test test test test test test test junk',
  password: 'Tester@1234',
} as const;

/**
 * Local Anvil network configuration
 */
export const ANVIL_NETWORK = {
  name: 'Anvil Local',
  rpcUrl: 'http://localhost:8545',
  chainId: 31337,
  symbol: 'ETH',
} as const;
