/**
 * @elizaos/confidant — secrets vault, mediation boundary, and audit surface
 * for Eliza agents. See `docs/architecture/confidant.md` in the Milady repo
 * for the full design rationale.
 *
 * Phase 0 surface — no runtime code calls Confidant yet. This package ships
 * the contract; Phase 1 wires it into the runtime.
 */

export { EnvLegacyBackend } from "./backends/env-legacy.js";
export { KeyringBackend } from "./backends/keyring.js";
export type { VaultBackend } from "./backends/types.js";
export {
  BackendError,
  BackendNotConfiguredError,
} from "./backends/types.js";
export type { Confidant, ConfidantOptions } from "./confidant.js";
export { createConfidant } from "./confidant.js";
export type { Envelope } from "./crypto/envelope.js";
export {
  decrypt,
  EnvelopeError,
  encrypt,
  generateMasterKey,
  KEY_BYTES,
} from "./crypto/envelope.js";
export type {
  KeyringMasterKeyOptions,
  MasterKeyResolver,
} from "./crypto/master-key.js";
export {
  inMemoryMasterKey,
  MasterKeyUnavailableError,
  osKeyringMasterKey,
} from "./crypto/master-key.js";
export {
  assertSecretId,
  InvalidSecretIdError,
  isSecretId,
  matchesPattern,
  selectMostSpecific,
} from "./identifiers.js";
export type {
  MirrorResult,
  ResolvedCredentialLike,
} from "./integrations/eliza-providers.js";
// elizaOS integration helpers — see ./integrations/*
// Comprehensive coverage of the full elizaOS plugin catalog: LLM
// providers, TTS/voice, messaging connectors, wallets, blockchain RPC,
// trading, music, storage, tools, and miscellaneous service tokens.
export {
  ELIZA_ENV_TO_SECRET_ID,
  ELIZA_PROVIDER_TO_SECRET_ID,
  envVarForSecretId,
  isDeviceBoundSecretId,
  isSubscriptionProviderId,
  mirrorLegacyEnvCredentials,
  providerIdForSecretId,
} from "./integrations/eliza-providers.js";
export {
  registerElizaProviderSchemas,
  registerElizaSecretSchemas,
} from "./integrations/eliza-schema.js";
export { AuditLog } from "./policy/audit.js";
export type { PolicyDecision, PolicyInput } from "./policy/grants.js";
export { decide, PermissionDeniedError } from "./policy/grants.js";
export type { ParsedReference } from "./references.js";
export {
  buildReference,
  InvalidReferenceError,
  parseReference,
} from "./references.js";
export type { ScopedConfidant } from "./scoped.js";
export {
  defineSecretSchema,
  listSchema,
  lookupSchema,
  SecretSchemaConflictError,
} from "./secret-schema.js";
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
