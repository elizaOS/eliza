/**
 * @elizaos/confidant — secrets vault, mediation boundary, and audit surface
 * for Eliza agents. See `docs/architecture/confidant.md` in the Milady repo
 * for the full design rationale.
 *
 * Phase 0 surface — no runtime code calls Confidant yet. This package ships
 * the contract; Phase 1 wires it into the runtime.
 */

export { createConfidant } from "./confidant.js";
export type { Confidant, ConfidantOptions } from "./confidant.js";
export type { ScopedConfidant } from "./scoped.js";

export {
  defineSecretSchema,
  lookupSchema,
  listSchema,
  SecretSchemaConflictError,
} from "./secret-schema.js";

export {
  assertSecretId,
  isSecretId,
  matchesPattern,
  selectMostSpecific,
  InvalidSecretIdError,
} from "./identifiers.js";

export {
  parseReference,
  buildReference,
  InvalidReferenceError,
} from "./references.js";

export type { ParsedReference } from "./references.js";

export {
  inMemoryMasterKey,
  osKeyringMasterKey,
  MasterKeyUnavailableError,
} from "./crypto/master-key.js";
export type {
  MasterKeyResolver,
  KeyringMasterKeyOptions,
} from "./crypto/master-key.js";

export {
  encrypt,
  decrypt,
  generateMasterKey,
  EnvelopeError,
  KEY_BYTES,
} from "./crypto/envelope.js";
export type { Envelope } from "./crypto/envelope.js";

export {
  BackendError,
  BackendNotConfiguredError,
} from "./backends/types.js";
export type { VaultBackend } from "./backends/types.js";

export { EnvLegacyBackend } from "./backends/env-legacy.js";
export { KeyringBackend } from "./backends/keyring.js";

export { decide, PermissionDeniedError } from "./policy/grants.js";
export type { PolicyDecision, PolicyInput } from "./policy/grants.js";

export { AuditLog } from "./policy/audit.js";

export type {
  AuditRecord,
  ConfidantLogger,
  Grant,
  GrantMode,
  PromptHandler,
  ResolveDetail,
  SecretDescriptor,
  SecretId,
  SecretSchemaEntry,
  VaultReference,
  VaultSource,
} from "./types.js";

// elizaOS integration helpers — see ./integrations/*
export {
  ELIZA_PROVIDER_SECRET_IDS,
  isSubscriptionProviderId,
  mirrorLegacyEnvCredentials,
  providerIdForSecretId,
} from "./integrations/eliza-providers.js";
export type {
  MirrorResult,
  ResolvedCredentialLike,
} from "./integrations/eliza-providers.js";
export { registerElizaProviderSchemas } from "./integrations/eliza-schema.js";
