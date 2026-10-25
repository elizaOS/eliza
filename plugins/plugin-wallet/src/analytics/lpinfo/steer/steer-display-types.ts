/**
 * Display-layer shapes for Steer vaults/pools rendered in steerLiquidityProvider.
 * These mirror the enriched objects built in SteerLiquidityService.
 */

export interface SteerGraphqlTokenRef {
  name: string;
  creator: { id: string };
  admin: string;
  executionBundle?: string;
}

export interface SteerGraphqlEnrichment {
  weeklyFeeAPR: number;
  token0Symbol: string;
  token0Decimals: number;
  token1Symbol: string;
  token1Decimals: number;
  token0Balance: string;
  token1Balance: string;
  totalLPTokensIssued: string;
  feeTier: number;
  fees0: string;
  fees1: string;
  strategyToken?: SteerGraphqlTokenRef;
  beaconName: string;
  payloadIpfs: string;
  deployer: string;
}

export interface SteerVaultPositionRow {
  type: string;
  range: string;
  liquidity: number;
}

/** Token slot may be raw address string or `{ address?: string }` */
export type SteerVaultTokenSide = string | { address?: string };

export interface SteerVaultDetailInput {
  address: string;
  /** Present on some SDK responses alongside `address` */
  vaultAddress?: string;
  name: string;
  chainId: number;
  tvl: number;
  volume24h: number;
  apy: number;
  strategyType: string;
  fee: number;
  createdAt: number;
  isActive: boolean;
  token0?: SteerVaultTokenSide | "Unknown";
  token1?: SteerVaultTokenSide | "Unknown";
  graphqlData?: SteerGraphqlEnrichment;
  calculatedTvl?: number;
  positions?: SteerVaultPositionRow[];
  /** Present on some SDK/GraphQL paths for downstream transactions */
  poolAddress?: string;
  singleAssetDepositContract?: `0x${string}`;
  weeklyFeeAPR?: number;
  /** Flattened GraphQL fields sometimes attached on `getVaultDetails` results */
  token0Symbol?: string;
  token1Symbol?: string;
  token0Balance?: string;
  token1Balance?: string;
  totalLPTokensIssued?: string;
  feeTier?: number;
  fees0?: string;
  fees1?: string;
  strategyToken?: SteerGraphqlTokenRef;
  beaconName?: string;
  deployer?: string;
  /** Extra SDK fields merged in `processVaultData` */
  ammType?: string | number;
  protocol?: string;
  protocolBaseType?: string;
  targetProtocol?: string;
  apr?: number;
  apr1d?: number;
  apr7d?: number;
  apr14d?: number;
  feeApr?: number;
  stakingApr?: number;
  merklApr?: number;
}

export interface SteerStakingPoolDetailInput {
  address: string;
  name: string;
  chainId: number;
  totalStakedUSD: number;
  apr: number;
  stakingToken: string;
  rewardToken: string;
  rewardRate: number;
  periodFinish: number;
  isActive: boolean;
}
