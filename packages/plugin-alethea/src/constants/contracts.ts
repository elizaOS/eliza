/**
 * Alethea AI Protocol Contract Addresses
 */

/**
 * Keys Factory (SharesFactoryV1) Contract Address
 * Contract Reference: https://github.com/AI-Protocol-Official/ai-protocol-v3-periphery/blob/master/contracts/bonding_curves/SharesFactoryV1.sol
 */
export const KEYS_FACTORY_ADDRESS = '0x80f5bcc38b18c0f0a18af3c6fba515c890689342';

/**
 * Implementation Types for ALI Agent creation
 */
export const IMPLEMENTATION_TYPES = {
  ETH: 0,
  ALI: 1,
} as const;

/**
 * Default implementation type for ALI Agent creation
 */
export const DEFAULT_IMPLEMENTATION_TYPE = IMPLEMENTATION_TYPES.ALI;

/**
 * iNFT Keys Factory (SharesFactoryV1) Contract Address (Ethereum Mainnet)
 * Contract Reference: Similar to SharesFactoryV1, but for iNFTs on Mainnet.
 * Guide: https://github.com/AI-Protocol-Official/Documentation/blob/main/guides/convert-inft-to-ali-agent/README.md
 */
export const INFT_KEYS_FACTORY_ADDRESS = '0xABA615044d5640bd151A1B0bdac1C04806AF1AD5';

/**
 * ALI Token Contract Address (Base Mainnet)
 * This is the token used for paying for keys.
 * Reference: https://basescan.org/token/0x97c806e7665d3afd84a8fe1837921403d59f3dcc
 */
export const ALI_TOKEN_ADDRESS = '0x97c806e7665d3afd84a8fe1837921403d59f3dcc';

/**
 * ALI Token Contract Address (Ethereum Mainnet)
 * This is the token used for iNFT intelligence upgrades and for paying for iNFT keys on Ethereum.
 * Reference: https://etherscan.io/token/0x6B0b3a982b4634aC68dD83a4DBF02311cE324181
 */
export const ALI_TOKEN_ADDRESS_ETHEREUM = '0x6B0b3a982b4634aC68dD83a4DBF02311cE324181';

/**
 * Default Pod NFT Contract Address (e.g., for Level 5 Pods on Base Mainnet)
 * This should be configured via environment variable if it can vary.
 * Users can also specify a different Pod contract address when calling the action.
 */
export const DEFAULT_POD_NFT_CONTRACT_ADDRESS = 'YOUR_DEFAULT_POD_NFT_CONTRACT_ADDRESS_HERE'; // Placeholder

/**
 * Disperse.app Contract Address (Base Mainnet)
 * Used for token airdrops and bulk token distributions
 * Reference: https://disperse.app/
 */
export const DISPERSE_APP_ADDRESS = '0xD152f549545093347A162Dce210e7293f1452150';

/**
 * Hive Registry Contract Address (Base Mainnet & Ethereum Mainnet)
 * Used for Hive operations - creating hives, linking assets, etc.
 * Reference: https://github.com/AI-Protocol-Official/Documentation/blob/main/guides/how-to-hive.md
 */
export const HIVE_REGISTRY_ADDRESS = '0x45deb2873681E46e0E9F58A83AbCa491E35aC423';

/**
 * Uniswap V3 Contract Addresses (Base Mainnet)
 * Used for creating liquidity pools and managing liquidity
 */
export const UNISWAP_V3_ADDRESSES = {
  FACTORY: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  POSITION_MANAGER: '0x03a520b32C04BF3bEEf7BF5d6E07AE8e1b0FE0F3',
  WETH: '0x4200000000000000000000000000000000000006', // Base WETH
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base USDC
} as const;

/**
 * Common Fee Tiers for Uniswap V3 Pools
 */
export const UNISWAP_V3_FEE_TIERS = {
  LOW: 500, // 0.05%
  MEDIUM: 3000, // 0.3%
  HIGH: 10000, // 1%
} as const;

/**
 * AI Pod Contract Address (Base Mainnet)
 * From documentation: 0xa189121eE045AEAA8DA80b72F7a1132e3B216237
 */
export const AI_POD_CONTRACT_ADDRESS = '0xa189121eE045AEAA8DA80b72F7a1132e3B216237';

/**
 * IntelligentNFTv2 Contract Address (Ethereum Mainnet)
 * This contract manages iNFT records and ALI token locking for intelligence upgrades.
 * Reference: https://etherscan.io/address/0xa189121eE045AEAA8DA80b72F7a1132e3B216237#code
 */
export const INTELLIGENT_NFT_V2_ADDRESS = '0xa189121eE045AEAA8DA80b72F7a1132e3B216237';

/**
 * PersonalityPod Contract Address (Ethereum Mainnet)
 * This ERC-721 contract represents the "soul" or "personality" of an iNFT.
 * Reference: https://etherscan.io/address/0xDd70AF84BA86F29bf437756B655110D134b5651C
 */
export const PERSONALITY_POD_CONTRACT_ADDRESS = '0xDd70AF84BA86F29bf437756B655110D134b5651C';
