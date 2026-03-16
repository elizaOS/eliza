import type { Address } from 'viem';

/**
 * PancakeSwap V3 specific types
 * PancakeSwap V3 is based on Uniswap V3 with some modifications
 */

export const PANCAKESWAP_V3_FEE_TIERS = {
  LOWEST: 100,    // 0.01%
  LOW: 500,       // 0.05%
  MEDIUM: 2500,   // 0.25%
  HIGH: 10000,    // 1%
} as const;

export type PancakeSwapV3FeeTier = typeof PANCAKESWAP_V3_FEE_TIERS[keyof typeof PANCAKESWAP_V3_FEE_TIERS];

// PancakeSwap V3 contract addresses by chain
export const PANCAKESWAP_V3_ADDRESSES: Record<number, {
  factory: Address;
  nonfungiblePositionManager: Address;
  swapRouter: Address;
  quoter: Address;
}> = {
  // BNB Smart Chain (BSC)
  56: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  },
  // Ethereum Mainnet
  1: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  },
  // Arbitrum One
  42161: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  },
  // Base
  8453: {
    factory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    nonfungiblePositionManager: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
    swapRouter: '0x1b81D678ffb9C0263b24A97847620C99d213eB14',
    quoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
  },
};

// ABIs are similar to Uniswap V3 - we reuse them
export { 
  UNISWAP_V3_FACTORY_ABI as PANCAKESWAP_V3_FACTORY_ABI,
  UNISWAP_V3_POOL_ABI as PANCAKESWAP_V3_POOL_ABI,
  UNISWAP_V3_POSITION_MANAGER_ABI as PANCAKESWAP_V3_POSITION_MANAGER_ABI,
  ERC20_ABI,
} from '../uniswap/types.ts';
