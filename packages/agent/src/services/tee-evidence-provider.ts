/**
 * Registration seam for the TEE attestation-evidence provider: the confidential-
 * VM deployment plugin registers its evidence-provider factory here, and the boot
 * gate resolves that registration (or undefined) rather than importing the
 * dstack/CoVE stack directly, so non-TEE builds never compile it. Fail-closed —
 * an unregistered provider under a required policy is treated as untrusted. See
 * the block below for the deployment rationale.
 */
import type { TeeEvidenceProvider } from "./tee-evidence.ts";

/**
 * Host-level seam between the fail-closed TEE boot gate (this package) and the
 * deployment-specific evidence provider that actually collects attestation
 * evidence (dstack `/run/dstack/*`, on-device CoVE quotes, ...). The concrete
 * provider is confidential-VM deployment code and lives in a TEE deployment
 * plugin (`@elizaos/plugin-tee`), NOT in trunk services — so desktop/mobile
 * builds that never load that plugin do not compile the dstack/CoVE stack.
 *
 * The plugin registers its factory here when a confidential-VM distribution
 * profile loads it; the boot gate then resolves the registered provider instead
 * of importing the concrete provider directly.
 *
 * Fail-closed contract: when NO factory is registered, `resolveTeeEvidenceProvider`
 * returns `undefined`. A boot gate that requires trusted TEE evidence but has no
 * provider treats that as untrusted and disables secrets (see
 * `evaluateTeeBootGate` — a required policy with an undefined provider yields
 * `secretsEnabled: false`). A non-TEE / local-only boot configures no required
 * policy, so an absent provider is inert and behaves exactly as before TEE
 * gating existed.
 */

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

/**
 * Resolve the registered TEE evidence provider, or `undefined` when no
 * deployment plugin has registered one. The boot gate passes the result to
 * `evaluateTeeBootGate`; an `undefined` provider under a required policy fails
 * closed (secrets disabled) rather than fabricating trust.
 */
export function resolveTeeEvidenceProvider(
  options?: TeeEvidenceProviderFactoryOptions,
): TeeEvidenceProvider | undefined {
  return registeredFactory ? registeredFactory(options) : undefined;
}
