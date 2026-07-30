import { SupportedChain, WalletExposureSummary } from "../types";

export type ExposureRegistryEntry =
  WalletExposureSummary["matches"][number];

const STATIC_SOLANA_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {};

const CHAIN_EXPOSURE_REGISTRIES: Partial<
  Record<SupportedChain, Readonly<Record<string, ExposureRegistryEntry>>>
> = {
  solana: STATIC_SOLANA_EXPOSURE_REGISTRY,
};

export function lookupStaticExposure(
  chain: SupportedChain,
  address: string | null | undefined,
): ExposureRegistryEntry | null {
  if (!address) {
    return null;
  }

  const registry = CHAIN_EXPOSURE_REGISTRIES[chain];

  return registry?.[address] ?? null;
}
