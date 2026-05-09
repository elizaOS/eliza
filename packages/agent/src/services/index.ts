export * from "./agent-export.js";
export * from "./app-manager.js";
export * from "./app-session-gate.js";
export { CodingTaskExecutor } from "./coding-task-executor.js";
export {
  EscalationService,
  type EscalationState,
  registerEscalationChannel,
} from "./escalation.js";
export * from "./overlay-app-presence.js";
// `plugin-manager-types` re-exports `RegistryPluginInfo` and
// `RegistrySearchResult` from `./registry-client-types.js`, which collide with
// the same names exported from `./registry-client.js`. Re-export the
// non-colliding names individually under stable aliases.
export {
  type CoreManagerLike,
  type CoreStatusLike,
  type EjectResult,
  type InstalledPluginInfo,
  type InstallProgressLike,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginInstallOptionsLike,
  type PluginInstallResult,
  type PluginManagerLike,
  type PluginUninstallResult,
  type RegistryPluginAppMeta,
  type RegistryPluginAppSessionFeature,
  type RegistryPluginAppSessionInfo,
  type RegistryPluginAppSessionMode,
  type RegistryPluginInfo as RegistryPluginManagerInfo,
  type RegistryPluginNpmInfo,
  type RegistryPluginViewerInfo,
  type RegistrySearchResult as RegistryPluginManagerSearchResult,
  type RegistryVersionSupport,
  type ReinjectResult,
  type SyncResult,
} from "./plugin-manager-types.js";
export * from "./registry-client.js";
export { resolveAppHeroImage } from "./registry-client-queries.js";
export * from "./remote-signing-service.js";
export { ResearchTaskExecutor } from "./research-task-executor.js";
export * from "./sandbox-engine.js";
export * from "./sandbox-manager.js";
export * from "./self-updater.js";
// `signal-pairing` and `whatsapp-pairing` both export `sanitizeAccountId`.
// Re-export each with the function name aliased to the connector to avoid
// collision while keeping all other names available from the bare barrel.
export {
  classifySignalPairingErrorStatus,
  extractSignalCliProvisioningUrl,
  parseSignalCliAccountsOutput,
  type SignalPairingEvent,
  type SignalPairingOptions,
  SignalPairingSession,
  type SignalPairingSnapshot,
  type SignalPairingStatus,
  sanitizeAccountId as sanitizeSignalAccountId,
  signalAuthExists,
  signalLogout,
} from "./signal-pairing.js";
export * from "./signing-policy.js";
export * from "./skill-catalog-client.js";
export * from "./skill-marketplace.js";
export * from "./stream-manager.js";
export * from "./task-executor.js";
export * from "./tts-stream-bridge.js";
export * from "./update-checker.js";
export * from "./version-compat.js";
export {
  sanitizeWhatsAppAccountId,
  type WhatsAppPairingEvent,
  type WhatsAppPairingOptions,
  WhatsAppPairingSession,
  type WhatsAppPairingStatus,
  whatsappAuthExists,
  whatsappLogout,
} from "@elizaos/plugin-whatsapp";
