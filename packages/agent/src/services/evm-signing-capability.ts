import type { EvmSigningCapabilityKind } from "@elizaos/shared";

/**
 * EVM signing capability resolver.
 *
 * Enumerates the possible paths for signing EVM transactions and reports
 * which (if any) is usable in the current process. A single authority for
 * "does plugin-wallet have a working signer?" — consumed by auto-enable logic
 * and wallet UI diagnostics so both agree on state.
 *
 * Paths (see `EvmSigningCapabilityKind` in shared/contracts/wallet.ts):
 *   - "local"         — EVM_PRIVATE_KEY is set and non-placeholder
 *   - "steward-self"  — self-hosted Steward (STEWARD_API_URL + STEWARD_AGENT_TOKEN,
 *                       ELIZA_CLOUD_PROVISIONED != "1")
 *   - "steward-cloud" — cloud-provisioned Steward sidecar (same creds,
 *                       ELIZA_CLOUD_PROVISIONED == "1")
 *   - "cloud-view-only" — cloud bind stored ELIZA_CLOUD_EVM_ADDRESS but no
 *                         signing path is wired (backend contract not yet
 *                         implemented locally). Address is visible, but no
 *                         transactions can be signed from this process.
 *   - "none"          — no address, no signer
 *
 * The UI surfaces `reason` verbatim, so it should be short and user-facing.
 */
export type { EvmSigningCapabilityKind };

export interface EvmSigningCapability {
  kind: EvmSigningCapabilityKind;
  /** True when this capability can sign transactions in-process. */
  canSign: boolean;
  /** Short reason string for logs + UI. */
  reason: string;
}

const NONE: EvmSigningCapability = {
  kind: "none",
  canSign: false,
  reason: "No EVM signing path configured",
};

/**
 * Placeholder patterns that we treat the same as "unset". Mirrors the
 * placeholder detection used in wallet.ts key validation so a stale
 * "[REDACTED]" in env doesn't spoof capability detection.
 */
const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

function isConcreteValue(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && !PLACEHOLDER_RE.test(trimmed as string);
}

export function resolveEvmSigningCapability(
  env: NodeJS.ProcessEnv = process.env,
): EvmSigningCapability {
  if (isConcreteValue(env.EVM_PRIVATE_KEY)) {
    return {
      kind: "local",
      canSign: true,
      reason: "env: EVM_PRIVATE_KEY",
    };
  }

  const stewardUrl = env.STEWARD_API_URL?.trim();
  const stewardToken = env.STEWARD_AGENT_TOKEN?.trim();
  if (stewardUrl && stewardToken) {
    const isCloud = env.ELIZA_CLOUD_PROVISIONED === "1";
    return isCloud
      ? {
          kind: "steward-cloud",
          canSign: true,
          reason: "cloud-provisioned Steward wallet",
        }
      : {
          kind: "steward-self",
          canSign: true,
          reason: "self-hosted Steward wallet",
        };
  }

  // Cloud bind persisted an address but no usable signing path is wired up
  // in this runtime. The UI can still show the address (view-only), but
  // plugin-wallet must NOT be auto-enabled — its actions would fail at runtime.
  const cloudAddress = env.ELIZA_CLOUD_EVM_ADDRESS?.trim();
  if (cloudAddress) {
    return {
      kind: "cloud-view-only",
      canSign: false,
      reason: "Cloud wallet provisioned (view-only — signing not yet wired)",
    };
  }

  return NONE;
}
