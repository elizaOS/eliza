/**
 * Hydrates the credential for the configured direct text provider from Vault.
 *
 * Packaged desktop runtimes are launched without a repository dotenv file. The
 * durable provider selection lives in serviceRouting while provider secrets
 * live in the protected Vault, so runtime construction needs this narrow
 * bridge. The revealed value is written only to a caller-owned settings
 * overlay, never global process.env; results expose only status and key names.
 */

import {
  getFirstRunProviderOption,
  normalizeFirstRunProviderId,
} from "@elizaos/shared";
import type { Vault } from "@elizaos/vault";
import { vaultKeyForProviderApiKey } from "./operations/vault-bridge.ts";

type ProviderCredentialVault = Pick<Vault, "has" | "reveal">;

export type ProviderVaultCredentialHydration =
  | {
      status: "hydrated";
      providerId: string;
      envKey: string;
      vaultKey: string;
    }
  | {
      status: "already-configured" | "missing" | "unavailable";
      providerId: string;
      envKey: string;
    }
  | {
      status: "not-applicable";
      providerId: string | null;
    };

const PROVIDER_CREDENTIAL_BOOT_CALLER =
  "runtime-boot:selected-provider-credential";

/**
 * Project the selected direct provider's protected credential into a runtime
 * settings overlay before AgentRuntime construction.
 *
 * Canonical provider keys win. The raw env-key fallback supports credentials
 * mirrored by the legacy process-env bootstrap. If the canonical entry exists
 * but cannot be revealed, fail closed and do not fall back to a potentially
 * stale legacy value.
 */
export async function hydrateSelectedProviderCredentialFromVault(args: {
  providerId: string | undefined;
  vault: ProviderCredentialVault;
  env?: NodeJS.ProcessEnv;
  settingsOverlay: Record<string, string>;
}): Promise<ProviderVaultCredentialHydration> {
  const providerId = normalizeFirstRunProviderId(args.providerId);
  const provider = providerId ? getFirstRunProviderOption(providerId) : null;
  const envKey = provider?.envKey;
  if (!providerId || !envKey) {
    return { status: "not-applicable", providerId };
  }

  const env = args.env ?? process.env;
  if (env[envKey]?.trim()) {
    return { status: "already-configured", providerId, envKey };
  }

  const canonicalVaultKey = vaultKeyForProviderApiKey(providerId);
  let selectedVaultKey: string | null = null;
  try {
    if (await args.vault.has(canonicalVaultKey)) {
      selectedVaultKey = canonicalVaultKey;
    } else if (await args.vault.has(envKey)) {
      selectedVaultKey = envKey;
    }
  } catch {
    // error-policy:J4 Boot continues without a provider credential. The
    // caller reports a redacted unavailable status; no caught error is logged
    // because storage errors may include protected-path details.
    return { status: "unavailable", providerId, envKey };
  }

  if (!selectedVaultKey) {
    return { status: "missing", providerId, envKey };
  }

  try {
    const credential = await args.vault.reveal(
      selectedVaultKey,
      PROVIDER_CREDENTIAL_BOOT_CALLER,
    );
    if (!credential.trim()) {
      return { status: "missing", providerId, envKey };
    }
    args.settingsOverlay[envKey] = credential;
    return {
      status: "hydrated",
      providerId,
      envKey,
      vaultKey: selectedVaultKey,
    };
  } catch {
    // error-policy:J4 Fail closed for the selected provider. In particular,
    // an unreadable canonical credential never falls back to the legacy key.
    return { status: "unavailable", providerId, envKey };
  }
}
