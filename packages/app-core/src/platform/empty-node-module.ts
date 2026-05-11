/**
 * Renderer-side stub module aliased from the @elizaos/agent (and other
 * Node-only) imports inside app-core / agent dist files. The renderer
 * never executes these code paths — the API child owns the real
 * implementations — but Rollup walks the static import graph during
 * bundling and fails the chunk with MISSING_EXPORT if any name listed
 * by a dist file isn't present here.
 *
 * The full list of @elizaos/agent names was enumerated by grep-ing
 * every static import of "@elizaos/agent" out of the compiled
 * eliza/packages/app-core/dist tree and unioning the brace contents.
 *
 * Adding a new name later: regenerate the list, append to the
 * appropriate section below. Categories:
 *   - SHOUTY_SNAKE_CASE → frozen empty array (acts as readonly never[])
 *   - PascalCase identifier → `type Foo = unknown`
 *   - camelCase identifier → async noop function
 *
 * Default export is a Proxy that returns a noop function for any
 * unknown member access, so `import default from "@elizaos/agent"`
 * style consumers don't blow up either.
 */

const noop = () => undefined;
const asyncNoop = async () => undefined;
const falseNoop = () => false;
const emptyArray = Object.freeze([]) as readonly never[];
const emptyRecord: Record<string, never> = Object.freeze({});

// ── Node/built-in helpers used by isolated dist code paths ──────────
export const pipeline = asyncNoop;
export const finished = asyncNoop;
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;

export const isAnyArrayBuffer = falseNoop;
export const isArrayBufferView = falseNoop;
export const isAsyncFunction = falseNoop;
export const isDate = falseNoop;
export const isMap = falseNoop;
export const isNativeError = falseNoop;
export const isPromise = falseNoop;
export const isRegExp = falseNoop;
export const isSet = falseNoop;
export const isTypedArray = falseNoop;

// ── @elizaos/agent stubs: constants ─────────────────────────────────
export const ACCOUNT_CREDENTIAL_PROVIDER_IDS = emptyArray;
export const AGENT_EVENT_ALLOWED_STREAMS = emptyArray;
export const CONFIG_WRITE_ALLOWED_TOP_KEYS = emptyArray;
export const CONNECTOR_ENV_MAP = emptyRecord;
export const CORE_PLUGINS = emptyArray;
export const CUSTOM_PLUGINS_DIRNAME = "";
export const DIRECT_ACCOUNT_PROVIDER_ENV = emptyRecord;
export const DIRECT_ACCOUNT_PROVIDER_IDS = emptyArray;
export const EMBEDDING_PRESETS = emptyArray;

// ── @elizaos/agent stubs: types ─────────────────────────────────────
export type BootElizaRuntimeOptions = unknown;
export type ConversationMeta = unknown;
export type ElizaConfig = unknown;
export type InstallPhase = unknown;
export type InstallProgress = unknown;
export type InstallResult = unknown;
export type ProgressCallback = unknown;
export type StartElizaOptions = unknown;
export type UninstallResult = unknown;

// ── @elizaos/agent stubs: functions ─────────────────────────────────
// All async noops. The renderer never invokes them; if a code path
// would, that's a logic bug — these stubs surface it as "function
// returned undefined" rather than as a build-time MISSING_EXPORT.
export const applyCanonicalOnboardingConfig = asyncNoop;
export const applyCloudConfigToEnv = asyncNoop;
export const applyOnboardingCredentialPersistence = asyncNoop;
export const applyPluginRuntimeMutation = asyncNoop;
export const bootElizaRuntime = asyncNoop;
export const buildCharacterFromConfig = asyncNoop;
export const checkForUpdate = asyncNoop;
export const clearPersistedOnboardingConfig = asyncNoop;
export const cloneWithoutBlockedObjectKeys = (value: unknown): unknown => value;
export const collectPluginNames = (): readonly never[] => emptyArray;
export const configureLocalEmbeddingPlugin = asyncNoop;
export const createElizaPlugin = asyncNoop;
export const detectEmbeddingTier = asyncNoop;
export const discoverInstalledPlugins = async (): Promise<readonly never[]> =>
  emptyArray;
export const discoverPluginsFromManifest = async (): Promise<
  readonly never[]
> => emptyArray;
export const ensureApiTokenForBindHost = asyncNoop;
export const executeTriggerTask = asyncNoop;
export const extractAuthToken = (): string | null => null;
export const fetchWithTimeoutGuard = asyncNoop;
export const findPrimaryEnvKey = (): string | null => null;
export const formatVaultRef = (): string => "";
export const getAccessToken = asyncNoop;
export const getLastFailedPluginNames = (): readonly never[] => emptyArray;
export const handleCloudBillingRoute = asyncNoop;
export const handleCloudCompatRoute = asyncNoop;
export const initStewardWalletCache = asyncNoop;
export const injectApiBaseIntoHtml = (html: string): string => html;
export const isAdvancedCapabilityPluginId = falseNoop;
export const isAllowedHost = falseNoop;
export const isAuthorized = falseNoop;
export const isPluginManagerLike = falseNoop;
export const isSafeResetStateDir = falseNoop;
export const isSubscriptionProvider = falseNoop;
export const isVaultRef = falseNoop;
export const listProviderAccounts = async (): Promise<readonly never[]> =>
  emptyArray;
export const listTriggerTasks = async (): Promise<readonly never[]> =>
  emptyArray;
export const loadElizaConfig = (): ElizaConfig => emptyRecord;
export const normalizeWsClientId = (value: unknown): string =>
  typeof value === "string" ? value : "";
export const parseVaultRef = (): null => null;
export const persistConfigEnv = asyncNoop;
export const persistConversationRoomTitle = asyncNoop;
export const readBundledPluginPackageMetadata = asyncNoop;
export const readConfigEnv = (): Record<string, never> => emptyRecord;
export const readTriggerConfig = asyncNoop;
export const registerJsRuntimeFactory = noop;
export const resolveAdvancedCapabilitiesEnabled = falseNoop;
export const resolveAppHeroImage = (): null => null;
export const resolveChannel = (): null => null;
export const resolveConfigPath = (): string => "";
export const resolveCorsOrigin = (): string => "";
export const resolveDefaultAgentWorkspaceDir = (): string => "";
export const resolveElizaVersion = (): string => "0.0.0";
export const resolveMcpServersRejection = (): null => null;
export const resolveMcpTerminalAuthorizationRejection = (): null => null;
export const resolvePackageEntry = (): null => null;
export const resolvePluginConfigMutationRejections = (): readonly never[] =>
  emptyArray;
export const resolveStateDir = (): string => "";
export const resolveTerminalRunClientId = (): string => "";
export const resolveTerminalRunRejection = (): null => null;
export const resolveUserPath = (path: string): string => path;
export const resolveWalletExportRejection = (): null => null;
export const resolveWebSocketUpgradeRejection = (): null => null;
export const routeAutonomyTextToUser = asyncNoop;
export const saveElizaConfig = asyncNoop;
export const scanDropInPlugins = async (): Promise<readonly never[]> =>
  emptyArray;
export const shutdownRuntime = asyncNoop;
export const startApiServer = asyncNoop;
export const startEliza = asyncNoop;
export const streamResponseBodyWithByteLimit = asyncNoop;
export const triggersFeatureEnabled = falseNoop;
export const validateMcpServerConfig = falseNoop;

// ── Additional @elizaos/agent stubs — types ─────────────────────────
export type AccountCredentialRecord = unknown;
export type CloudProxyConfigLike = unknown;
export type DatabaseSync = unknown;
export type DocumentAddedByRole = unknown;
export type DocumentAddedFrom = unknown;
export type DocumentSearchMode = unknown;
export type DocumentVisibilityScope = unknown;
export type DocumentsLoadFailReason = unknown;
export type DocumentsServiceLike = unknown;
export type DocumentsServiceResult = unknown;
export type DropService = unknown;
export type PluginModuleShape = unknown;
export type RegistryService = unknown;
export type ReleaseChannel = unknown;
export type Trajectory = unknown;
export type TxService = unknown;

// ── Additional @elizaos/agent stubs — functions ─────────────────────
export const computeNextCronRunAtMs = (): number => 0;
export const createIntegrationTelemetrySpan = noop;
export const createZipArchive = asyncNoop;
export const extractActionParamsViaLlm = asyncNoop;
export const extractCompatTextContent = (): string => "";
export const extractPlugin = noop;
export const gatePluginSessionForHostedApp = <T,>(plugin: T): T => plugin;
export const getAgentEventService = (): null => null;
export const getDocumentsService = (): null => null;
export const getDocumentsServiceTimeoutMs = (): number => 0;
export const getWalletAddresses = (): Record<string, never> => emptyRecord;
export const handleConnectorAccountRoutes = asyncNoop;
export const hasOwnerAccess = falseNoop;
export const parseCronExpression = noop;
export const registerEscalationChannel = noop;
export const renderGroundedActionReply = asyncNoop;
export const resolveOAuthDir = (): string => "";
export const resolveOwnerEntityId = (): string => "";
export const runCoordinatorPreflight = asyncNoop;
export const setStewardEvmBridgeActive = noop;

// ── Default export ──────────────────────────────────────────────────
export default new Proxy(noop, {
  get: () => noop,
  apply: () => undefined,
});

// elizaOS server-only stubs (browser bundle reach-through)
export const ACCOUNT_CREDENTIAL_PROVIDER_IDS = [];
export const AGENT_EVENT_ALLOWED_STREAMS = [];
export const applyCanonicalOnboardingConfig = noop;
export const applyCloudConfigToEnv = noop;
export const applyOnboardingCredentialPersistence = noop;
export const applyPluginRuntimeMutation = noop;
export const bootElizaRuntime = noop;
export const buildCharacterFromConfig = noop;
export const checkForUpdate = noop;
export const clearCloudSecrets = noop;
export const clearPersistedOnboardingConfig = noop;
export const cloneWithoutBlockedObjectKeys = noop;
export const collectPluginNames = noop;
export const configureLocalEmbeddingPlugin = noop;
export const CONFIG_WRITE_ALLOWED_TOP_KEYS = [];
export const CONNECTOR_ENV_MAP = [];
export const CORE_PLUGINS = [];
export const createElizaPlugin = noop;
export const CUSTOM_PLUGINS_DIRNAME = [];
export const detectEmbeddingTier = noop;
export const DIRECT_ACCOUNT_PROVIDER_ENV = [];
export const DIRECT_ACCOUNT_PROVIDER_IDS = [];
export const discoverInstalledPlugins = noop;
export const discoverPluginsFromManifest = noop;
export const EMBEDDING_PRESETS = [];
export const ensureApiTokenForBindHost = noop;
export const ensureCloudTtsApiKeyAlias = noop;
export const executeTriggerTask = noop;
export const extractAuthToken = noop;
export const fetchWithTimeoutGuard = noop;
export const findPrimaryEnvKey = noop;
export const formatVaultRef = noop;
export const getAccessToken = noop;
export const getCloudSecret = noop;
export const getLastFailedPluginNames = noop;
export const handleCloudBillingRoute = noop;
export const handleCloudCompatRoute = noop;
export const handleCloudTtsPreviewRoute = noop;
export const initStewardWalletCache = noop;
export const injectApiBaseIntoHtml = noop;
export const InstallPhase = noop;
export const InstallProgress = noop;
export const InstallResult = noop;
export const isAdvancedCapabilityPluginId = noop;
export const isAllowedHost = noop;
export const isAuthorized = noop;
export const isPluginManagerLike = noop;
export const isSafeResetStateDir = noop;
export const isSubscriptionProvider = noop;
export const isVaultRef = noop;
export const listProviderAccounts = noop;
export const listTriggerTasks = noop;
export const loadElizaConfig = noop;
export const mirrorCompatHeaders = noop;
export const normalizeCloudSiteUrl = noop;
export const normalizeWsClientId = noop;
export const parseVaultRef = noop;
export const persistConfigEnv = noop;
export const persistConversationRoomTitle = noop;
export const ProgressCallback = noop;
export const readBundledPluginPackageMetadata = noop;
export const readConfigEnv = noop;
export const readTriggerConfig = noop;
export const registerJsRuntimeFactory = noop;
export const __resetCloudBaseUrlCache = noop;
export const resolveAdvancedCapabilitiesEnabled = noop;
export const resolveAppHeroImage = noop;
export const resolveChannel = noop;
export const resolveCloudTtsBaseUrl = noop;
export const resolveConfigPath = noop;
export const resolveCorsOrigin = noop;
export const resolveDefaultAgentWorkspaceDir = noop;
export const resolveElevenLabsApiKeyForCloudMode = noop;
export const resolveElizaVersion = noop;
export const resolveMcpServersRejection = noop;
export const resolveMcpTerminalAuthorizationRejection = noop;
export const resolvePackageEntry = noop;
export const resolvePluginConfigMutationRejections = noop;
export const resolveStateDir = noop;
export const resolveTerminalRunClientId = noop;
export const resolveTerminalRunRejection = noop;
export const resolveUserPath = noop;
export const resolveWalletExportRejection = noop;
export const resolveWebSocketUpgradeRejection = noop;
export const routeAutonomyTextToUser = noop;
export const saveElizaConfig = noop;
export const scanDropInPlugins = noop;
export const shutdownRuntime = noop;
export const startApiServer = noop;
export const startEliza = noop;
export const streamResponseBodyWithByteLimit = noop;
export const triggersFeatureEnabled = noop;
export const typeBootElizaRuntimeOptions = noop;
export const typeConversationMeta = noop;
export const typeElizaConfig = noop;
export const typeStartElizaOptions = noop;
export const UninstallResult = noop;
export const validateMcpServerConfig = noop;
