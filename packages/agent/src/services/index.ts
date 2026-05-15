// Signal pairing helpers live in @elizaos/plugin-signal. Re-exported here
// for backward compatibility with code that imports them from @elizaos/agent.

const codingToolsModule = await import("@elizaos/plugin-coding-tools");
const signalModule = await import("@elizaos/plugin-signal");
const whatsAppModule = await import("@elizaos/plugin-whatsapp");

export const { CodingTaskExecutor } = codingToolsModule;
export const {
  classifySignalPairingErrorStatus,
  extractSignalCliProvisioningUrl,
  parseSignalCliAccountsOutput,
  SignalPairingSession,
  sanitizeSignalAccountId,
  signalAuthExists,
  signalLogout,
} = signalModule;
export const {
  sanitizeWhatsAppAccountId,
  WhatsAppPairingSession,
  whatsappAuthExists,
  whatsappLogout,
} = whatsAppModule;

export type CodingTaskExecutor = InstanceType<typeof CodingTaskExecutor>;
export type SignalPairingEvent = Record<string, unknown>;
export type SignalPairingOptions = Record<string, unknown>;
export type SignalPairingSession = InstanceType<typeof SignalPairingSession>;
export type SignalPairingSnapshot = Record<string, unknown>;
export type SignalPairingStatus = string;
export type WhatsAppPairingEvent = Record<string, unknown>;
export type WhatsAppPairingOptions = Record<string, unknown>;
export type WhatsAppPairingSession = InstanceType<
  typeof WhatsAppPairingSession
>;
export type WhatsAppPairingStatus = string;
export * from "./agent-export.ts";
export * from "./app-manager.ts";
export * from "./app-session-gate.ts";
export {
  type AuditedDecision,
  type BrokerOptions,
  type BrokerSnapshot,
  CapabilityBroker,
  type CapabilityDecision,
  type CapabilityKind,
  type CapabilityOp,
  type CapabilityRequest,
  getCapabilityBroker,
} from "./capability-broker.ts";
export {
  EscalationService,
  type EscalationState,
  registerEscalationChannel,
} from "./escalation.ts";
export * from "./mcp-marketplace.ts";
export * from "./overlay-app-presence.ts";
export {
  type IPermissionsRegistry,
  PERMISSIONS_REGISTRY_SERVICE,
  PermissionRegistry,
  type PermissionRegistryOptions,
  type Prober,
} from "./permissions-registry.ts";
export * from "./plugin-compiler.ts";
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
} from "./plugin-manager-types.ts";
export * from "./registry-client.ts";
export { resolveAppHeroImage } from "./registry-client-queries.ts";
export * from "./remote-signing-service.ts";
export { ResearchTaskExecutor } from "./research-task-executor.ts";
export * from "./sandbox-engine.ts";
export * from "./sandbox-manager.ts";
export * from "./self-updater.ts";
export {
  resolveShellExecutionMode,
  runShell,
  type ShellExecutionMode,
  type ShellRequest,
  type ShellResult,
  type ShellRouterContext,
  type ShellSandboxBackend,
} from "./shell-execution-router.ts";
export * from "./signing-policy.ts";
export * from "./task-executor.ts";
export * from "./update-checker.ts";
export * from "./version-compat.ts";
export * from "./virtual-filesystem.ts";
