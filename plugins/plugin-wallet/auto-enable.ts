// Auto-enable check for @elizaos/plugin-wallet.
//
// Plugin manifest entry-point — referenced by package.json's
// `elizaos.plugin.autoEnableModule`. Keep this module light: env reads only,
// no service init, no transitive imports of the full plugin runtime. The
// auto-enable engine loads dozens of these per boot.
//
// EVM detection mirrors `evmAutoEnableReasonFromCapability` in
// packages/agent/src/services/evm-signing-capability.ts — kept inline so this
// module has no cross-package import that would pull in agent/runtime code.
import type { PluginAutoEnableContext } from "@elizaos/core";

const PLACEHOLDER_RE =
  /^\[?\s*(REDACTED|PLACEHOLDER|T(?:O)D(?:O)|CHANGEME|EMPTY)\s*]?$/i;

function isConcreteValue(value: string | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed) && !PLACEHOLDER_RE.test(trimmed as string);
}

/** True when any EVM signing path is available (local key or Steward). */
function hasEvmSigningPath(env: NodeJS.ProcessEnv): boolean {
  if (isConcreteValue(env.EVM_PRIVATE_KEY)) return true;
  const stewardUrl = env.STEWARD_API_URL?.trim();
  const stewardToken = env.STEWARD_AGENT_TOKEN?.trim();
  return Boolean(stewardUrl && stewardToken);
}

/** True when a Solana private key is set. */
function hasSolanaSigningPath(env: NodeJS.ProcessEnv): boolean {
  return (
    typeof env.SOLANA_PRIVATE_KEY === "string" &&
    env.SOLANA_PRIVATE_KEY.trim().length > 0
  );
}

/** True when cloud-provisioned Steward credentials are present. */
function hasCloudStewardWallet(env: NodeJS.ProcessEnv): boolean {
  return (
    env.ELIZA_CLOUD_PROVISIONED === "1" &&
    Boolean(env.STEWARD_API_URL?.trim()) &&
    Boolean(env.STEWARD_AGENT_TOKEN?.trim())
  );
}

/**
 * Enable plugin-wallet when ANY signing path is available:
 *   - EVM (local key or self-hosted/cloud Steward)
 *   - Solana local key
 *   - cloud-provisioned Steward
 *
 * Honors `ELIZA_AGENT_WALLET_AUTO_ENABLE === "0"` opt-out, and respects an
 * explicit `enabled: false` on any of plugin-wallet's legacy entry names
 * (`wallet`, `agent-wallet`, `evm`, `solana`). The central engine only
 * checks the canonical short id (`wallet`); the legacy aliases need to be
 * honored here.
 */
export function shouldEnable(ctx: PluginAutoEnableContext): boolean {
  const { env, config } = ctx;

  if (env.ELIZA_AGENT_WALLET_AUTO_ENABLE === "0") return false;

  const entries = (config?.plugins as Record<string, unknown> | undefined)
    ?.entries as Record<string, { enabled?: boolean } | undefined> | undefined;
  if (entries) {
    for (const id of ["wallet", "agent-wallet", "evm", "solana"] as const) {
      if (entries[id]?.enabled === false) return false;
    }
  }

  return (
    hasEvmSigningPath(env) ||
    hasSolanaSigningPath(env) ||
    hasCloudStewardWallet(env)
  );
}
