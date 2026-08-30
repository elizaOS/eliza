/**
 * Hydrates the configured direct text provider credential from protected Vault.
 *
 * Packaged desktop runtimes do not inherit repository dotenv files. The value
 * is projected only into a caller-owned runtime settings overlay so unrelated
 * child processes never inherit a Vault-only provider secret.
 */

import { ElizaError } from "@elizaos/core";
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
      status: "already-configured" | "missing";
      providerId: string;
      envKey: string;
    }
  | { status: "not-applicable"; providerId: string | null };

const PROVIDER_CREDENTIAL_BOOT_CALLER =
  "runtime-boot:selected-provider-credential";

function providerCredentialUnavailable(
  providerId: string,
  envKey: string,
  stage: "lookup" | "reveal",
  cause: unknown,
  vaultKey?: string,
): ElizaError {
  return new ElizaError(
    `Selected provider credential for ${providerId} is unavailable from Vault`,
    {
      code: "SELECTED_PROVIDER_CREDENTIAL_UNAVAILABLE",
      severity: "fatal",
      context: {
        providerId,
        envKey,
        stage,
        ...(vaultKey ? { vaultKey } : {}),
      },
      cause,
    },
  );
}

/** Project one selected provider credential into runtime settings. */
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
  } catch (error) {
    // error-policy:J2 A selected provider's Vault is required boot input. Keep
    // the storage cause and stop before a runtime can advertise chat readiness.
    throw providerCredentialUnavailable(providerId, envKey, "lookup", error);
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
  } catch (error) {
    // error-policy:J2 An unreadable selected credential is not equivalent to
    // an absent one and must never fall back to a different protected value.
    throw providerCredentialUnavailable(
      providerId,
      envKey,
      "reveal",
      error,
      selectedVaultKey,
    );
  }
}
