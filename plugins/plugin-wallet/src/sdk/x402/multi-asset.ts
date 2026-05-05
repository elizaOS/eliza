/**
 * @module x402/multi-asset
 * Multi-asset support utilities for the x402 payment client.
 *
 * Resolves asset names/symbols → token addresses via the global TokenRegistry.
 * This extends x402 beyond USDC-only to support any token the 402 response requests.
 *
 * All address lookups use the TokenRegistry from src/tokens/registry.ts.
 * Fallback: USDC_ADDRESSES from x402/types.ts.
 */

import type { Address } from "viem";
import { getGlobalRegistry } from "../tokens/registry.js";
import { USDC_ADDRESSES } from "./types.js";

/**
 * Network string format used in x402: "chainName:chainId" (e.g. "base:8453").
 * Returns the chainId portion as a number.
 */
export function parseNetworkChainId(network: string): number | null {
  const parts = network.split(":");
  if (parts.length < 2) return null;
  const id = parseInt(parts[parts.length - 1], 10);
  return Number.isNaN(id) ? null : id;
}

/**
 * Resolve an asset address in the context of a 402 response.
 * The asset field may be:
 *   1. A token symbol ("USDC", "WETH", etc.) → look up in registry by symbol
 *   2. A hex contract address → look up in registry by address (must be registered)
 *
 * Only returns an address if the asset is known in the TokenRegistry.
 * Unknown addresses are NOT accepted — they must be explicitly added or
 * whitelisted via supportedAssets config.
 *
 * @param asset - Asset identifier from the 402 response
 * @param network - Network string from the 402 response (e.g. "base:8453")
 * @returns Resolved contract address, or null if not found in registry
 */
export function resolveAssetAddress(
  asset: string,
  network: string,
): Address | null {
  const chainId = parseNetworkChainId(network);
  if (chainId == null) return null;

  const registry = getGlobalRegistry();

  // If it looks like an EVM address, check registry by address
  if (/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    const entry = registry.getTokenByAddress(asset as Address, chainId);
    if (entry) return entry.address;
    return null; // unknown address — reject for safety
  }

  // Try registry lookup by symbol (e.g. "USDC", "WETH")
  const entry = registry.getToken(asset.toUpperCase(), chainId);
  if (entry) return entry.address;

  return null;
}

/**
 * Get token decimals for a given asset+network pair.
 * Used to correctly format amounts in x402 payments.
 *
 * @param asset - Asset address (hex) or symbol
 * @param network - Network string (e.g. "base:8453")
 * @returns Decimals, defaults to 6 for USDC-like stable, 18 for everything else
 */
export function resolveAssetDecimals(asset: string, network: string): number {
  const chainId = parseNetworkChainId(network);
  if (chainId == null) return 6;

  const registry = getGlobalRegistry();

  // Try by address first
  if (/^0x[0-9a-fA-F]{40}$/.test(asset)) {
    const entry = registry.getTokenByAddress(asset as Address, chainId);
    if (entry) return entry.decimals;
    // Unknown token — default to 18
    return 18;
  }

  // Try by symbol
  const entry = registry.getToken(asset.toUpperCase(), chainId);
  if (entry) return entry.decimals;

  return 18;
}

/**
 * Build a set of accepted payment assets for an x402 client, using the
 * global registry to auto-populate known tokens per network.
 *
 * @param networks - List of network strings (e.g. ["base:8453", "arbitrum:42161"])
 * @param symbols - Token symbols to include (e.g. ["USDC", "USDT", "WETH"])
 * @returns Map from network string → array of token addresses
 */
export function buildSupportedAssets(
  networks: string[],
  symbols: string[] = ["USDC", "USDT", "DAI", "WETH"],
): Record<string, Address[]> {
  const result: Record<string, Address[]> = {};
  const registry = getGlobalRegistry();

  for (const network of networks) {
    const chainId = parseNetworkChainId(network);
    if (chainId == null) continue;

    const addrs: Address[] = [];

    for (const symbol of symbols) {
      const entry = registry.getToken(symbol, chainId);
      if (entry && !entry.isNative) {
        addrs.push(entry.address);
      }
    }

    // Always include USDC from the existing USDC_ADDRESSES table as fallback
    const usdcFallback = USDC_ADDRESSES[network];
    if (
      usdcFallback &&
      !addrs.some((a) => a.toLowerCase() === usdcFallback.toLowerCase())
    ) {
      addrs.push(usdcFallback);
    }

    if (addrs.length > 0) {
      result[network] = addrs;
    }
  }

  return result;
}

/**
 * Check if a given asset address is a known stablecoin (6 decimals) on the network.
 */
export function isStablecoin(asset: string, network: string): boolean {
  const decimals = resolveAssetDecimals(asset, network);
  return decimals === 6;
}
