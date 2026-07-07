import { WalletExposureSummary } from "../types";

export type ExposureRegistryEntry =
  WalletExposureSummary["matches"][number];

const STATIC_SOLANA_EXPOSURE_REGISTRY: Record<string, ExposureRegistryEntry> = {};

export function lookupStaticSolanaExposure(
  address: string | null | undefined,
): ExposureRegistryEntry | null {
  if (!address) {
    return null;
  }

  return STATIC_SOLANA_EXPOSURE_REGISTRY[address] ?? null;
}
