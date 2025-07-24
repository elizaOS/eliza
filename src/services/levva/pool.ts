import { arbitrum } from "viem/chains";
import poolAbi from "./abi/pool.abi";
import { getChain, getClient } from "../../util";
import vaultAbi from "./abi/vault.abi";
import { logger } from "@elizaos/core";

// fixme rename module to strategy?

export type CoreStrategy = "ultra-safe" | "safe" | "brave";
export type CustomStrategy = "custom";
export type Strategy = CoreStrategy | CustomStrategy;
export type StrategyType = "vault" | "pool";

export interface StrategyMapping {
  description: string;
  contractAddress: `0x${string}`;
  vaultChainId: number;
  type: StrategyType;
  bundler?: `0x${string}`;
}

export interface StrategyEntry extends StrategyMapping {
  strategy: Strategy;
}

/** @deprecated need api */
export const strategyVaultMapping: Record<Strategy, StrategyMapping[]> = {
  "ultra-safe": [
    {
      description: [
        "Like a high-yield savings account, but better. Earn consistent returns with minimal",
        "risk. Get exposure to on-chain Lending protocols (Aave, Morpho) and stablecoins which capture",
        "funding rate arbitrage between spot and forward markets (Ethena, Resolv).",
      ].join(" "),
      contractAddress: "0x1ae8fA6Ec02f71C26F01228cc071fFEE06698078",
      vaultChainId: arbitrum.id,
      type: "vault",
    },
  ],
  safe: [
    {
      description: [
        "Identical to the Safe-yield strategy, but we're adding 10% ETH exposure to the mix,",
        "to capture the ETH upside and earn additional 2-3% on your ETH holdings via ETH native staking",
        "yield. This effectively increases risk-adjusted returns for you, while keeping your portfolio",
        "drawdowns relatively small.",
      ].join(" "),
      contractAddress: "0x9172C0C316Cab74486EfC9Bf77C39A6358e39ff0",
      vaultChainId: arbitrum.id,
      type: "vault",
    },
  ],
  brave: [
    {
      description: [
        "This strategy targets maximum compound annual growth rate and is suitable to",
        "more risky investors who think about maximizing their long term growth. This strategy is roughly",
        "70% in safe-yield strategies and other 30% allocated to BTC, ETH via their yield-generating",
        "wrapper tokens (Etherfi, Lido).",
      ].join(" "),
      contractAddress: "0xaE9119AbA39399011109819C1a2f9436dEAe2c4b",
      vaultChainId: arbitrum.id,
      type: "vault",
    },
  ],
  custom: [
    {
      description: [
        "100% Allocation to ETH-based derivative tokens (liquid staking and liquid restaking",
        "tokens). which provide additional 2-3% APR. These tokens are further put into on-chain Lending",
        "markets to generate additional 2-3% APR on top of the basic LST/LRT yield (Etherfi, Lido).",
      ].join(" "),
      contractAddress: "0xaE9119AbA39399011109819C1a2f9436dEAe2c4b",
      vaultChainId: arbitrum.id,
      type: "vault",
    },
    {
      description: "Leverage PT-weETH tokens, high yield, expires 25 Jun 2026",
      contractAddress: "0x4F890EE86aabc87F915282341552aB6F781E5B3a",
      vaultChainId: arbitrum.id,
      type: "pool",
      bundler: "0x11AD57D588011ddc1165A91352103294B70d9cf6",
    },
  ],
};

export const getPoolConstants = async (
  chainId: number,
  address: `0x${string}`
) => {
  const chain = getChain(chainId);
  const client = getClient(chain);
  logger.debug(`Getting pool constants for ${address}`);

  const [baseToken, defaultSwapCallData, quoteToken] = await Promise.all([
    client.readContract({
      abi: poolAbi,
      address,
      functionName: "baseToken",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "defaultSwapCallData",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "quoteToken",
    }),
  ]);

  const result = {
    baseToken,
    defaultSwapCallData: defaultSwapCallData.toString(),
    quoteToken,
  };

  logger.debug(`Pool constants: ${JSON.stringify(result)}`);

  return result;
};

export const getPoolVariables = async (
  chainId: number,
  address: `0x${string}`
) => {
  const chain = getChain(chainId);
  const client = getClient(chain);

  const [
    baseCollateralCoeff,
    baseDebtCoeff,
    baseDelevCoeff,
    discountedBaseCollateral,
    discountedBaseDebt,
    discountedQuoteCollateral,
    discountedQuoteDebt,
    price,
    quoteCollateralCoeff,
    quoteDebtCoeff,
    quoteDelevCoeff,
  ] = await Promise.all([
    client.readContract({
      abi: poolAbi,
      address,
      functionName: "baseCollateralCoeff",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "baseDebtCoeff",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "baseDelevCoeff",
    }),
    client.readContract({
      abi: poolAbi,
      address,
      functionName: "discountedBaseCollateral",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "discountedBaseDebt",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "discountedQuoteCollateral",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "discountedQuoteDebt",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "getLiquidationPrice",
    }),
    client.readContract({
      abi: poolAbi,
      address,
      functionName: "quoteCollateralCoeff",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "quoteDebtCoeff",
    }),

    client.readContract({
      abi: poolAbi,
      address,
      functionName: "quoteDelevCoeff",
    }),
  ]);

  return {
    baseCollateralCoeff: baseCollateralCoeff,
    baseDebtCoeff: baseDebtCoeff,
    baseDelevCoeff: baseDelevCoeff,
    discountedBaseCollateral,
    discountedBaseDebt,
    discountedQuoteCollateral,
    discountedQuoteDebt,
    price: price.inner,
    quoteCollateralCoeff,
    quoteDebtCoeff,
    quoteDelevCoeff,
  };
};

export const getVaultConstants = async (
  chainId: number,
  address: `0x${string}`
) => {
  const chain = getChain(chainId);
  const client = getClient(chain);

  const asset = await client.readContract({
    abi: vaultAbi,
    address,
    functionName: "asset",
  });

  return {
    asset,
  };
};

export type PoolConstants = Awaited<ReturnType<typeof getPoolConstants>>;
export type PoolVariables = Awaited<ReturnType<typeof getPoolVariables>>;
export type VaultConstants = Awaited<ReturnType<typeof getVaultConstants>>;

export interface PoolDescription {
  chainId: number;
  address: `0x${string}`;
  description: string;
  /** @deprecated fixme should not use mockup data in future */
  mock?: PoolConstants;
}

export interface LevvaPoolInterface {
  getStrategies: (chainId?: number) => Promise<StrategyEntry[]>;

  getPoolConstants: (
    chainId: number,
    address: `0x${string}`
  ) => Promise<PoolConstants>;

  getPoolVariables: (
    chainId: number,
    address: `0x${string}`
  ) => Promise<PoolVariables>;

  getVaultConstants: (
    chainId: number,
    address: `0x${string}`
  ) => Promise<VaultConstants>;
}
