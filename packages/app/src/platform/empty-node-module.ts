/**
 * Universal empty-module alias target for browser builds. tsconfig-paths maps
 * both a handful of Node built-ins (stream `pipeline`/`finished`, the WHATWG
 * stream globals, `util/types` `isX` guards) and a large roster of server-only
 * `@elizaos/agent` / `@elizaos/plugin-elizacloud` exports onto this file, so the
 * renderer graph resolves every named import without pulling in Node-only code.
 * Unsupported calls throw an explicit error; erased contracts remain available.
 * The default export also rejects calls and unknown property access. Intentionally NOT re-exported from `index.ts` — doing so
 * would shadow the real Node `api/server` / `runtime/eliza` exports; Node imports
 * the originals while bundlers alias in this stub.
 */
import { ElizaError } from "@elizaos/shared/browser-contracts";

/** Server imports may be linked, but executing them in a renderer is a bug. */
export function unsupportedServerOperation(): never {
  throw new ElizaError(
    "Server-only operation is unavailable in the browser renderer",
    {
      code: "BROWSER_SERVER_OPERATION_UNAVAILABLE",
    },
  );
}

const asyncUnavailable = async (): Promise<never> =>
  unsupportedServerOperation();

export const pipeline = asyncUnavailable;
export const finished = asyncUnavailable;
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;

export const isAnyArrayBuffer = unsupportedServerOperation;
export const isArrayBufferView = unsupportedServerOperation;
export const isAsyncFunction = unsupportedServerOperation;
export const isDate = unsupportedServerOperation;
export const isMap = unsupportedServerOperation;
export const isNativeError = unsupportedServerOperation;
export const isPromise = unsupportedServerOperation;
export const isRegExp = unsupportedServerOperation;
export const isSet = unsupportedServerOperation;
export const isTypedArray = unsupportedServerOperation;

export default new Proxy(unsupportedServerOperation, {
  get: unsupportedServerOperation,
});

// elizaOS server-only browser aliases (bundle reach-through)
export const ACCOUNT_CREDENTIAL_PROVIDER_IDS = [];
export const AGENT_EVENT_ALLOWED_STREAMS = [];
export const applyCanonicalFirstRunConfig = unsupportedServerOperation;
export const applyCloudConfigToEnv = unsupportedServerOperation;
export const applyFirstRunCredentialPersistence = unsupportedServerOperation;
export const applyAdvancedCapabilitiesConfig = unsupportedServerOperation;
export const applyPluginRuntimeMutation = unsupportedServerOperation;
export const bootElizaRuntime = unsupportedServerOperation;
export const buildCharacterFromConfig = unsupportedServerOperation;
export const checkForUpdate = unsupportedServerOperation;
export const clearCloudSecrets = unsupportedServerOperation;
export const clearPersistedFirstRunConfig = unsupportedServerOperation;
export const cloneWithoutBlockedObjectKeys = unsupportedServerOperation;
export const collectPluginNames = unsupportedServerOperation;
export const configureLocalEmbeddingPlugin = unsupportedServerOperation;
export const CONFIG_WRITE_ALLOWED_TOP_KEYS = [];
export const CONNECTOR_ENV_MAP = [];
export const CORE_PLUGINS = [];
export const createElizaPlugin = unsupportedServerOperation;
export const CUSTOM_PLUGINS_DIRNAME = [];
export const detectEmbeddingTier = unsupportedServerOperation;
export const DIRECT_ACCOUNT_PROVIDER_ENV = [];
export const DIRECT_ACCOUNT_PROVIDER_IDS = [];
export const discoverInstalledPlugins = unsupportedServerOperation;
export const discoverPluginsFromManifest = unsupportedServerOperation;
export const EMBEDDING_PRESETS = [];
export const ensureApiTokenForBindHost = unsupportedServerOperation;
export const ensureCloudTtsApiKeyAlias = unsupportedServerOperation;
export const executeTriggerTask = unsupportedServerOperation;
export const extractAuthToken = unsupportedServerOperation;
export const fetchWithTimeoutGuard = unsupportedServerOperation;
export const findPrimaryEnvKey = unsupportedServerOperation;
export const formatVaultRef = unsupportedServerOperation;
export const getAccessToken = unsupportedServerOperation;
export const getCloudSecret = unsupportedServerOperation;
export const getLastFailedPluginNames = unsupportedServerOperation;
export const getPluginWidgets = unsupportedServerOperation;
export const handleCloudBillingRoute = unsupportedServerOperation;
export const handleCloudCompatRoute = unsupportedServerOperation;
export const handleCloudTtsPreviewRoute = unsupportedServerOperation;
export const initStewardWalletCache = unsupportedServerOperation;
export const injectApiBaseIntoHtml = unsupportedServerOperation;
export const InstallPhase = unsupportedServerOperation;
export const InstallProgress = unsupportedServerOperation;
export const InstallResult = unsupportedServerOperation;
export const isAdvancedCapabilityPluginId = unsupportedServerOperation;
export const isAllowedHost = unsupportedServerOperation;
export const isAuthorized = unsupportedServerOperation;
export const isPluginManagerLike = unsupportedServerOperation;
export const isSafeResetStateDir = unsupportedServerOperation;
export const isSubscriptionProvider = unsupportedServerOperation;
export const isVaultRef = unsupportedServerOperation;
export const listProviderAccounts = unsupportedServerOperation;
export const listTriggerTasks = unsupportedServerOperation;
export const loadElizaConfig = unsupportedServerOperation;
export const mirrorCompatHeaders = unsupportedServerOperation;
export const normalizeCloudSiteUrl = unsupportedServerOperation;
export const normalizeWsClientId = unsupportedServerOperation;
export const OPTIONAL_CORE_PLUGINS = [];
export const parseVaultRef = unsupportedServerOperation;
export const persistConfigEnv = unsupportedServerOperation;
export const persistConversationRoomTitle = unsupportedServerOperation;
export const ProgressCallback = unsupportedServerOperation;
export const readBundledPluginPackageMetadata = unsupportedServerOperation;
export const readConfigEnv = unsupportedServerOperation;
export const readTriggerConfig = unsupportedServerOperation;
export const registerJsRuntimeFactory = unsupportedServerOperation;
export const __resetCloudBaseUrlCache = unsupportedServerOperation;
export const resolveAdvancedCapabilitiesEnabled = unsupportedServerOperation;
export const resolveAppHeroImage = unsupportedServerOperation;
export const resolveChannel = unsupportedServerOperation;
export const resolveCloudApiBaseUrl = unsupportedServerOperation;
export const resolveCloudTtsBaseUrl = unsupportedServerOperation;
export const resolveConfigPath = unsupportedServerOperation;
export const resolveCorsOrigin = unsupportedServerOperation;
export const resolveDefaultAgentWorkspaceDir = unsupportedServerOperation;
export const resolveElevenLabsApiKeyForCloudMode = unsupportedServerOperation;
export const resolveElizaVersion = unsupportedServerOperation;
export const resolveMcpServersRejection = unsupportedServerOperation;
export const resolveMcpTerminalAuthorizationRejection =
  unsupportedServerOperation;
export const resolvePackageEntry = unsupportedServerOperation;
export const resolvePluginConfigMutationRejections = unsupportedServerOperation;
export const resolveStateDir = unsupportedServerOperation;
export const resolveTerminalRunClientId = unsupportedServerOperation;
export const resolveTerminalRunRejection = unsupportedServerOperation;
export const resolveUserPath = unsupportedServerOperation;
export const resolveWalletExportRejection = unsupportedServerOperation;
export const resolveWebSocketUpgradeRejection = unsupportedServerOperation;
export const routeAutonomyTextToUser = unsupportedServerOperation;
export const saveElizaConfig = unsupportedServerOperation;
export const scanDropInPlugins = unsupportedServerOperation;
export const shutdownRuntime = unsupportedServerOperation;
export const startApiServer = unsupportedServerOperation;
export const startEliza = unsupportedServerOperation;
export const streamResponseBodyWithByteLimit = unsupportedServerOperation;
export const triggersFeatureEnabled = unsupportedServerOperation;
export const typeBootElizaRuntimeOptions = unsupportedServerOperation;
export const typeConversationMeta = unsupportedServerOperation;
export const typeElizaConfig = unsupportedServerOperation;
export const typeStartElizaOptions = unsupportedServerOperation;
export const UninstallResult = unsupportedServerOperation;
export const validatePluginConfig = unsupportedServerOperation;

// ── Extra @elizaos/agent browser aliases surfaced by plugin dist files ────────
// Upstream's enumeration only walked app/dist; the broader plugin
// graph (app-knowledge, etc.) static-imports additional
// names. Append rather than edit upstream aliases to keep merge churn
// minimal.
export type AccountCredentialRecord = unknown;
export type BootElizaRuntimeOptions = unknown;
export type CloudProxyConfigLike = unknown;
export type ConversationMeta = unknown;
export type DatabaseSync = unknown;
export type DocumentAddedByRole = unknown;
export type DocumentAddedFrom = unknown;
export type DocumentSearchMode = unknown;
export type DocumentVisibilityScope = unknown;
export type DocumentsLoadFailReason = unknown;
export type DocumentsServiceLike = unknown;
export type DocumentsServiceResult = unknown;
export type DropService = unknown;
export type ElizaConfig = unknown;
export type PluginModuleShape = unknown;
export type RegistryService = unknown;
export type ReleaseChannel = unknown;
export type StartElizaOptions = unknown;
export type Trajectory = unknown;
export type TxService = unknown;

export const computeNextCronRunAtMs = unsupportedServerOperation;
export const createIntegrationTelemetrySpan = unsupportedServerOperation;
export const createZipArchive = unsupportedServerOperation;
export const extractActionParamsViaLlm = unsupportedServerOperation;
export const extractCompatTextContent = unsupportedServerOperation;
export const extractPlugin = unsupportedServerOperation;
export const gatePluginSessionForHostedApp = unsupportedServerOperation;
export const getAgentEventService = unsupportedServerOperation;
export const getDocumentsService = unsupportedServerOperation;
export const getDocumentsServiceTimeoutMs = unsupportedServerOperation;
export const getWalletAddresses = unsupportedServerOperation;
export const handleConnectorAccountRoutes = unsupportedServerOperation;
export const hasOwnerAccess = unsupportedServerOperation;
export const parseCronExpression = unsupportedServerOperation;
export const registerEscalationChannel = unsupportedServerOperation;
export const renderGroundedActionReply = unsupportedServerOperation;
export const resolveOAuthDir = unsupportedServerOperation;
export const resolveOwnerEntityId = unsupportedServerOperation;
export const runCoordinatorPreflight = unsupportedServerOperation;
