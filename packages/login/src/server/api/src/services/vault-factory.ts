import { createRequire } from "node:module";
import { logger } from "@elizaos/logger";
import { isDevSecretAllowed } from "../../../auth/src/index.ts";
import {
  AwsKmsExternalKeyCustodyProvider,
  KmsEnvelopeKeystore,
  Vault,
} from "../../../vault/src/index.ts";

const require = createRequire(import.meta.url);

export type VaultMode = "local" | "kms-envelope:aws" | "kms-envelope:pkcs11";
export type ExternalCustodyProviderName = "aws-kms";

/**
 * Explicit acknowledgement that this deployment runs the weakest custody
 * posture (`local`: AES-256-GCM at rest, plaintext key bytes in application
 * memory at sign time) in production. Set to `"true"` to proceed.
 *
 * This mirrors the adapter-registry `STEWARD_ALLOW_MOCK_ADAPTERS` gate: a silent
 * weak default in production becomes a deliberate, recorded operator decision.
 * Unlike the `STEWARD_ALLOW_*` family (which unblocks an otherwise-refused
 * capability), this flag does not change WHAT local mode can do — it only forces
 * the operator to acknowledge the posture before the root of trust boots.
 *
 * See docs/security/custody-posture.md for the full threat model.
 */
export const LOCAL_CUSTODY_ACK_ENV = "STEWARD_ACK_LOCAL_CUSTODY";

export class LocalCustodyAcknowledgementRequiredError extends Error {
  readonly code = "local_custody_acknowledgement_required";
  constructor() {
    super(
      "Refusing to boot: NODE_ENV=production with local plaintext custody " +
        "(mode=local). In local mode the private key is decrypted to plaintext in " +
        "application memory at sign time, so a memory-scrape of this process " +
        `exposes every key. Acknowledge this posture explicitly by setting ${LOCAL_CUSTODY_ACK_ENV}=true, ` +
        "or move to a stronger backend (STEWARD_KMS_PROVIDER=aws|pkcs11, or an " +
        "external-custody provider). See docs/security/custody-posture.md.",
    );
  }
}

export const VAULT_SIGNING_CAPABILITIES = Object.freeze([
  "sign_transaction",
  "sign_message",
  "sign_raw_hash",
  "sign_raw_digest",
  "sign_typed_data",
  "sign_user_operation",
  "sign_eip7702_authorization",
  "sign_solana_transaction",
  "sign_solana_message",
  "sign_bitcoin_psbt",
  "sign_monero_transfer",
] as const);

export type VaultSigningCapability =
  (typeof VAULT_SIGNING_CAPABILITIES)[number];

export const VAULT_CAPABILITY_REGISTRY: Readonly<
  Record<VaultMode, Readonly<Record<VaultSigningCapability, true>>>
> = Object.freeze({
  local: Object.freeze(
    Object.fromEntries(VAULT_SIGNING_CAPABILITIES.map((name) => [name, true])),
  ),
  "kms-envelope:aws": Object.freeze(
    Object.fromEntries(VAULT_SIGNING_CAPABILITIES.map((name) => [name, true])),
  ),
  "kms-envelope:pkcs11": Object.freeze(
    Object.fromEntries(VAULT_SIGNING_CAPABILITIES.map((name) => [name, true])),
  ),
}) as Readonly<
  Record<VaultMode, Readonly<Record<VaultSigningCapability, true>>>
>;

export interface ConfiguredVaultOptions {
  allowDevSecretFallback?: boolean;
  fallbackPassword?: string;
}

const vaultsByKey = new Map<string, Vault>();
let warnedDevSecretFallback = false;

function configuredKmsProvider(): "aws" | "pkcs11" | undefined {
  const value = process.env.STEWARD_KMS_PROVIDER?.trim();
  if (!value) return undefined;
  if (value === "aws" || value === "pkcs11") return value;
  throw new Error(`Unsupported STEWARD_KMS_PROVIDER: ${value}`);
}

function configuredExternalCustodyProvider():
  | ExternalCustodyProviderName
  | undefined {
  const value = process.env.STEWARD_EXTERNAL_CUSTODY_PROVIDER?.trim();
  if (!value) return undefined;
  if (value === "aws-kms") return value;
  throw new Error(`Unsupported STEWARD_EXTERNAL_CUSTODY_PROVIDER: ${value}`);
}

function createExternalCustodyProvider() {
  const provider = configuredExternalCustodyProvider();
  if (!provider) return undefined;
  // External signing uses the same optional AWS SDK package as envelope mode,
  // but it is deliberately selected by a separate configuration key and never
  // changes the keystore backend.
  try {
    require.resolve("@aws-sdk/client-kms");
  } catch {
    throw new Error(
      "@aws-sdk/client-kms is required when STEWARD_EXTERNAL_CUSTODY_PROVIDER=aws-kms",
    );
  }
  return AwsKmsExternalKeyCustodyProvider.fromEnv();
}

function requireKmsConfiguration(provider: "aws" | "pkcs11"): void {
  if (provider === "aws") {
    if (
      !process.env.STEWARD_KMS_KEY_ID?.trim() &&
      !process.env.STEWARD_AWS_KMS_KEY_ARN?.trim()
    ) {
      throw new Error(
        "STEWARD_KMS_KEY_ID or STEWARD_AWS_KMS_KEY_ARN is required for AWS KMS",
      );
    }
    return;
  }

  const missing = [
    ["STEWARD_PKCS11_MODULE", process.env.STEWARD_PKCS11_MODULE],
    ["STEWARD_PKCS11_PIN", process.env.STEWARD_PKCS11_PIN],
    ["STEWARD_PKCS11_KEY_LABEL", process.env.STEWARD_PKCS11_KEY_LABEL],
  ]
    .filter(([, value]) => !value?.trim())
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} required for PKCS#11 KMS`);
  }
}

/**
 * True when the resolved custody mode materializes plaintext private-key bytes
 * in this process's memory at sign time. This is the honest boundary from
 * VISION.md: `local` AND both `kms-envelope:*` modes decrypt the key to a
 * plaintext string in-process before signing. Only an external-custody provider
 * (wired via VaultConfig.externalKeyCustodyProvider, not a vault-factory mode)
 * keeps plaintext out of this process entirely.
 *
 * The acknowledgement gate below is scoped narrowly to `local` — the weakest
 * mode, where the key is ALSO plaintext at rest inside the app's own DB unless
 * an operator adds a KMS/HSM wrap. KMS-envelope modes already require explicit
 * KMS configuration, which is itself a deliberate operator decision.
 */
export function modeExposesPlaintextAtSignTime(mode: VaultMode): boolean {
  // Every vault-factory mode currently decrypts to plaintext in-process before
  // signing. Enumerated (not a blanket `true`) so a future signing-in-HSM mode
  // must be added here deliberately rather than defaulting into "safe".
  switch (mode) {
    case "local":
    case "kms-envelope:aws":
    case "kms-envelope:pkcs11":
      return true;
    default: {
      // Unknown mode: fail closed (treat as plaintext-exposing).
      const _exhaustive: never = mode;
      return true;
    }
  }
}

function localCustodyAcknowledged(): boolean {
  return process.env[LOCAL_CUSTODY_ACK_ENV] === "true";
}

/**
 * Fail closed if this deployment would silently boot the weakest custody
 * posture in production. The root of trust must never boot weak SILENTLY:
 * production + local plaintext custody + no explicit acknowledgement => throw.
 *
 * Development/test ergonomics are unchanged (the gate only fires when
 * NODE_ENV === "production"). Stronger modes (KMS-envelope) pass without the
 * ack because selecting them is already an explicit configuration decision.
 */
export function assertProductionCustodyAcknowledged(mode: VaultMode): void {
  if (process.env.NODE_ENV !== "production") return;
  if (mode !== "local") return;
  if (localCustodyAcknowledged()) return;
  throw new LocalCustodyAcknowledgementRequiredError();
}

function configuredMode(): VaultMode {
  const provider = configuredKmsProvider();
  if (!provider) return "local";
  requireKmsConfiguration(provider);

  // KMS clients are optional peers and KmsEnvelopeKeystore loads them lazily.
  // Resolve them here so the API startup check fails before accepting traffic.
  const moduleName =
    provider === "aws" ? "@aws-sdk/client-kms" : "graphene-pk11";
  try {
    require.resolve(moduleName);
  } catch {
    throw new Error(
      `${moduleName} is required when STEWARD_KMS_PROVIDER=${provider}`,
    );
  }
  return provider === "aws" ? "kms-envelope:aws" : "kms-envelope:pkcs11";
}

function resolveMasterPassword(options: ConfiguredVaultOptions): string {
  const configured = process.env.STEWARD_MASTER_PASSWORD?.trim();
  if (configured) return configured;
  if (options.fallbackPassword?.trim()) return options.fallbackPassword.trim();

  if (options.allowDevSecretFallback) {
    if (!isDevSecretAllowed()) {
      throw new Error(
        "STEWARD_MASTER_PASSWORD must be set. For local development only, opt in to the insecure dev fallback with STEWARD_ALLOW_DEV_SECRETS=true.",
      );
    }
    if (!warnedDevSecretFallback) {
      warnedDevSecretFallback = true;
      logger.warn(
        {
          details: [
            "[steward] DEV ONLY: using insecure dev-secret as vault master password. Set STEWARD_MASTER_PASSWORD before production.",
          ],
        },
        "[Login:vault-factory] warn",
      );
    }
    return "dev-secret";
  }

  throw new Error("STEWARD_MASTER_PASSWORD is required");
}

export function createConfiguredVault(
  options: ConfiguredVaultOptions = {},
): Vault {
  const mode = configuredMode();
  // Root-of-trust gate: never silently boot local plaintext custody in prod.
  assertProductionCustodyAcknowledged(mode);
  const masterPassword = resolveMasterPassword(options);
  return new Vault({
    masterPassword,
    rpcUrl: process.env.RPC_URL || "https://sepolia.base.org",
    chainId: parseInt(process.env.CHAIN_ID || "84532", 10),
    ...(mode === "local"
      ? {}
      : { keystoreBackend: KmsEnvelopeKeystore.fromEnv() }),
    ...(configuredExternalCustodyProvider()
      ? { externalKeyCustodyProvider: createExternalCustodyProvider() }
      : {}),
  });
}

export function getConfiguredVault(
  options: ConfiguredVaultOptions = {},
): Vault {
  const mode = configuredMode();
  const externalCustody = configuredExternalCustodyProvider() ?? "none";
  const masterPassword = resolveMasterPassword(options);
  const key = `${mode}:${externalCustody}:${masterPassword}`;
  let vault = vaultsByKey.get(key);
  if (!vault) {
    vault = createConfiguredVault({
      ...options,
      fallbackPassword: masterPassword,
    });
    vaultsByKey.set(key, vault);
  }
  return vault;
}

export function configuredVaultStartupLogLine(): string {
  const provider = configuredKmsProvider();
  const mode: VaultMode = provider ? `kms-envelope:${provider}` : "local";
  const plaintextAtSignTime = modeExposesPlaintextAtSignTime(mode);
  const externalCustody = configuredExternalCustodyProvider() ?? "none";
  // In production, local mode only reaches this point when the operator has
  // explicitly acknowledged the weak posture (see assertProductionCustodyAcknowledged).
  // Surface that acknowledgement in the boot log so it is auditable. Never emit
  // key material, KMS key ids, or the master password here.
  const ack =
    mode === "local" && process.env.NODE_ENV === "production"
      ? ` local_custody_acknowledged=${localCustodyAcknowledged()}`
      : "";
  return (
    `[steward] vault mode=${mode} external_custody=${externalCustody} ` +
    `plaintext_at_sign_time=${plaintextAtSignTime}${ack} ` +
    `capabilities=${VAULT_SIGNING_CAPABILITIES.join(",")}`
  );
}

export function _clearConfiguredVaultsForTests(): void {
  vaultsByKey.clear();
  warnedDevSecretFallback = false;
}
