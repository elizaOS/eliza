/**
 * Fail-closed payout rail allowlist for the July 4 launch (#13100).
 *
 * The launch decision requires that only `base:usdc` is enabled. Other rails
 * (ethereum, bnb, solana) and the legacy `eliza` asset are defined as
 * *supported capabilities* — they exist in code — but are NOT enabled launch
 * rails. They cannot be quoted, created, approved, selected, or executed until
 * an operator explicitly opts them in.
 *
 * This is a money-moving path: fail closed. Any rail not on the allowlist is
 * rejected. There is no silent fallback.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import type { PayoutAsset } from "./payout-assets";
import { isPayoutAsset } from "./payout-assets";
import type { SupportedNetwork } from "../services/eliza-token-price";
import type { EvmPayoutNetwork } from "./payout-evm-resolver";

/** Portable process-env-like type for optional override parameters. */
type ProcessEnvLike = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// RAIL IDENTIFIER
// ---------------------------------------------------------------------------

/**
 * A payout rail is a network + asset combination, expressed as
 * `"<network>:<asset>"` (e.g. `"base:usdc"`).
 */
export type PayoutRail = `${SupportedNetwork}:${PayoutAsset}`;

export function makeRail(network: SupportedNetwork, asset: PayoutAsset): PayoutRail {
  return `${network}:${asset}`;
}

export function parseRail(rail: string): { network: SupportedNetwork; asset: PayoutAsset } | null {
  const idx = rail.indexOf(":");
  if (idx < 0) return null;
  const network = rail.slice(0, idx) as SupportedNetwork;
  const asset = rail.slice(idx + 1) as PayoutAsset;
  if (!isPayoutAsset(asset)) return null;
  // Network validity: must be a known key
  const knownNetworks: readonly SupportedNetwork[] = ["ethereum", "base", "bnb", "solana"];
  if (!knownNetworks.includes(network)) return null;
  return { network, asset };
}

// ---------------------------------------------------------------------------
// CAPABILITIES vs ENABLED RAILS
// ---------------------------------------------------------------------------

/**
 * All payout rails that the codebase *supports* (capabilities). These are
 * distinct from enabled rails — a capability means the code can handle it, not
 * that a payout may actually move on it.
 */
export const SUPPORTED_PAYOUT_RAILS: readonly PayoutRail[] = [
  "base:usdc",
  "base:eliza",
  "ethereum:usdc",
  "ethereum:eliza",
  "bnb:usdc",
  "bnb:eliza",
  "solana:usdc",
  "solana:eliza",
] as const;

/**
 * The default enabled rails for the July 4 launch. Only `base:usdc`.
 *
 * This is fail-closed: absent an explicit operator override, NO other rail is
 * enabled. An operator can extend the allowlist via `PAYOUT_ENABLED_RAILS`
 * (comma-separated), but the default is exactly one rail.
 */
export const DEFAULT_ENABLED_RAILS: readonly PayoutRail[] = ["base:usdc"] as const;

// ---------------------------------------------------------------------------
// ALLOWLIST RESOLUTION
// ---------------------------------------------------------------------------

/**
 * Resolve the enabled payout rails from cloud-aware bindings.
 *
 * Reads `PAYOUT_ENABLED_RAILS` (comma-separated rail identifiers) through
 * {@link getCloudAwareEnv}. If unset or empty, falls back to
 * {@link DEFAULT_ENABLED_RAILS} (`base:usdc` only).
 *
 * Unknown rails in the env var are filtered out and logged. A valid rail that
 * is not in {@link SUPPORTED_PAYOUT_RAILS} is silently dropped — operators
 * cannot enable something the code does not support.
 *
 * @param envOverride Optional env override (for testing).
 * @returns The set of enabled payout rails. Never empty in practice (defaults
 *          to `base:usdc`), but callers should still fail-closed on unknown.
 */
export function getEnabledPayoutRails(envOverride?: ProcessEnvLike): Set<PayoutRail> {
  const env = envOverride ?? getCloudAwareEnv();
  const raw = env.PAYOUT_ENABLED_RAILS;

  if (!raw || !raw.trim()) {
    return new Set(DEFAULT_ENABLED_RAILS);
  }

  const parsed = raw
    .split(",")
    .map((r: string) => r.trim())
    .filter(Boolean);

  const supported = new Set(SUPPORTED_PAYOUT_RAILS);
  const enabled = new Set<PayoutRail>();

  for (const rail of parsed) {
    if (supported.has(rail as PayoutRail)) {
      enabled.add(rail as PayoutRail);
    }
    // Silently drop unknown/unsupported rails — fail closed.
  }

  // If the operator somehow clears the list, fall back to the default.
  if (enabled.size === 0) {
    return new Set(DEFAULT_ENABLED_RAILS);
  }

  return enabled;
}

// ---------------------------------------------------------------------------
// GATE FUNCTION
// ---------------------------------------------------------------------------

/**
 * Result of a rail allowlist check.
 */
export interface RailAllowlistResult {
  allowed: boolean;
  rail: PayoutRail;
  reason?: string;
}

/**
 * Check whether a network + asset combination is on the enabled payout
 * allowlist. This is the single gate function used at every enforcement point:
 * quote, create, status, approval, selection, and execution.
 *
 * Fail-closed: any rail not explicitly enabled is rejected.
 *
 * @param network The payout network.
 * @param asset   The payout asset.
 * @param envOverride Optional env override (for testing).
 */
export function isRailEnabled(
  network: SupportedNetwork,
  asset: PayoutAsset,
  envOverride?: ProcessEnvLike,
): RailAllowlistResult {
  const rail = makeRail(network, asset);
  const enabled = getEnabledPayoutRails(envOverride);

  if (enabled.has(rail)) {
    return { allowed: true, rail };
  }

  return {
    allowed: false,
    rail,
    reason: `Payout rail ${rail} is not enabled. Enabled rails: ${[...enabled].join(", ")}`,
  };
}

/**
 * Assert that a rail is enabled, throwing if not. Use at enforcement points
 * where a thrown error is the appropriate failure mode.
 *
 * @throws Error if the rail is not on the allowlist.
 */
export function assertRailEnabled(
  network: SupportedNetwork,
  asset: PayoutAsset,
  envOverride?: ProcessEnvLike,
): void {
  const result = isRailEnabled(network, asset, envOverride);
  if (!result.allowed) {
    throw new Error(result.reason ?? `Payout rail ${result.rail} is not enabled`);
  }
}

/**
 * Check whether an EVM network is enabled for a given asset. Convenience for
 * EVM-specific payout paths.
 */
export function isEvmRailEnabled(
  network: EvmPayoutNetwork,
  asset: PayoutAsset,
  envOverride?: ProcessEnvLike,
): boolean {
  // EvmPayoutNetwork is a subset of SupportedNetwork
  return isRailEnabled(network as SupportedNetwork, asset, envOverride).allowed;
}

/**
 * Get the list of enabled EVM networks for a given asset. Used by the payout
 * processor and status service to iterate only enabled rails.
 */
export function getEnabledEvmNetworks(
  asset: PayoutAsset,
  envOverride?: ProcessEnvLike,
): EvmPayoutNetwork[] {
  const enabled = getEnabledPayoutRails(envOverride);
  const evmNetworks: EvmPayoutNetwork[] = ["ethereum", "base", "bnb"];
  return evmNetworks.filter((n) => enabled.has(makeRail(n as SupportedNetwork, asset)));
}
