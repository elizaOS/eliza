/**
 * Resolves TEE evidence from an explicitly configured pinned dstack verifier or
 * a deployment plugin registration. Missing providers remain undefined so the
 * required boot gate fails closed; conflicting providers reject configuration.
 */
import { ElizaError } from "@elizaos/core";
import {
  createDstackEvidenceProvider,
  dstackEvidenceConfiguration,
} from "./tee-dstack-evidence.ts";
import type { TeeEvidenceProvider } from "./tee-evidence.ts";

export type TeeEvidenceProviderFactoryOptions = {
  env?: Record<string, string | undefined>;
};

export type TeeEvidenceProviderFactory = (
  options?: TeeEvidenceProviderFactoryOptions,
) => TeeEvidenceProvider;

let registeredFactory: TeeEvidenceProviderFactory | undefined;

/**
 * Register the deployment's TEE evidence-provider factory. Called by the TEE
 * deployment plugin on load. The last registration wins; a CVM image loads
 * exactly one TEE provider plugin.
 */
export function registerTeeEvidenceProviderFactory(
  factory: TeeEvidenceProviderFactory,
): void {
  registeredFactory = factory;
}

/** True when a deployment has registered an evidence-provider factory. */
export function hasTeeEvidenceProviderFactory(): boolean {
  return registeredFactory !== undefined;
}

/** Reset the registration. Tests only — production registers exactly once. */
export function clearTeeEvidenceProviderFactory(): void {
  registeredFactory = undefined;
}

/** Resolves one explicit provider; absent deployment configuration stays inert. */
export function resolveTeeEvidenceProvider(
  options?: TeeEvidenceProviderFactoryOptions,
): TeeEvidenceProvider | undefined {
  const env = options?.env ?? process.env;
  const configured = env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON;
  if (configured !== undefined) {
    if (registeredFactory) {
      throw new ElizaError(
        "Configure either dstack evidence or a registered provider, not both",
        { code: "TEE_EVIDENCE_PROVIDER_CONFLICT" },
      );
    }
    try {
      return createDstackEvidenceProvider(
        dstackEvidenceConfiguration.parse(JSON.parse(configured)),
      );
    } catch (error) {
      // error-policy:J2 Malformed configuration must never disable the provider.
      throw new ElizaError("Invalid dstack evidence configuration", {
        code: "TEE_DSTACK_CONFIGURATION_INVALID",
        cause: error,
      });
    }
  }
  return registeredFactory ? registeredFactory(options) : undefined;
}
