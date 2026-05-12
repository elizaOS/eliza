/**
 * @elizaos/vault — simple secrets/config vault.
 *
 *   import { createVault } from "@elizaos/vault";
 *
 *   const vault = createVault();
 *   await vault.set("openrouter.apiKey", "sk-or-v1-...", { sensitive: true });
 *   await vault.set("ui.theme", "dark");
 *   const apiKey = await vault.get("openrouter.apiKey");
 *
 * One API for sensitive credentials and non-sensitive config. Sensitive
 * values encrypted at rest with the master key in the OS keychain.
 * Password-manager references (1Password, Proton Pass) are first-class
 * — the value lives there, the vault stores only the reference.
 */

export { createVault, VaultMissError } from "./vault.js";
export type {
  CreateVaultOptions,
  SetOptions,
  Vault,
} from "./vault.js";
export {
  PgliteVaultImpl,
  defaultPgliteVaultDataDir,
} from "./pglite-vault.js";
export type { PgliteVaultOptions } from "./pglite-vault.js";

export {
  defaultMasterKey,
  inMemoryMasterKey,
  MasterKeyUnavailableError,
  osKeychainMasterKey,
  passphraseMasterKey,
  passphraseMasterKeyFromEnv,
} from "./master-key.js";
export type {
  MasterKeyResolver,
  OsKeychainOptions,
  PassphraseOptions,
} from "./master-key.js";

export {
  encrypt,
  decrypt,
  generateMasterKey,
  KEY_BYTES,
  CryptoError,
} from "./crypto.js";

export {
  PasswordManagerError,
  resolveReference,
} from "./password-managers.js";

export {
  createManager,
  DEFAULT_PREFERENCES,
} from "./manager.js";
export type {
  BackendId,
  BackendStatus,
  CreateManagerOptions,
  ListAllSavedLoginsOptions,
  ManagerPreferences,
  ManagerSetOptions,
  SecretsManager,
  UnifiedLoginListEntry,
  UnifiedLoginListResult,
  UnifiedLoginReveal,
} from "./manager.js";

export {
  BackendNotSignedInError,
  defaultExecFn,
  listBitwardenLogins,
  listOnePasswordLogins,
  revealBitwardenLogin,
  revealOnePasswordLogin,
} from "./external-credentials.js";
export type {
  ExecFn,
  ExternalLoginListEntry,
  ExternalLoginReveal,
  ExternalLoginSource,
} from "./external-credentials.js";

export {
  BACKEND_INSTALL_SPECS,
  buildInstallCommand,
  currentPlatform,
  detectPackageManagers,
  resetInstallerCache,
  resolveRunnableMethods,
} from "./install.js";
export type {
  BackendInstallSpec,
  InstallMethod,
  InstallMethodKind,
  PackageManagerAvailability,
  SupportedPlatform,
} from "./install.js";

export type {
  AuditRecord,
  PasswordManagerReference,
  VaultDescriptor,
  VaultLogger,
  VaultStats,
} from "./types.js";

export {
  deleteSavedLogin,
  getAutofillAllowed,
  getSavedLogin,
  listSavedLogins,
  setAutofillAllowed,
  setSavedLogin,
} from "./credentials.js";
export type { SavedLogin, SavedLoginSummary } from "./credentials.js";

export {
  categorizeKey,
  inferProviderId,
  listVaultInventory,
  META_PREFIX,
  profileStorageKey,
  PROFILE_SEGMENT,
  readEntryMeta,
  removeEntryMeta,
  ROUTING_KEY,
  setEntryMeta,
} from "./inventory.js";
export type {
  VaultEntryCategory,
  VaultEntryMeta,
  VaultEntryMetaRecord,
  VaultEntryMetaUpdate,
  VaultEntryProfile,
} from "./inventory.js";

export {
  readRoutingConfig,
  resolveActiveValue,
  writeRoutingConfig,
} from "./profiles.js";
export type {
  ResolutionContext,
  RoutingConfig,
  RoutingRule,
  RoutingScope,
  RoutingScopeKind,
} from "./profiles.js";
export * from "./testing.js";
