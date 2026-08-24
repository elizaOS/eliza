/**
 * First-run onboarding HTTP routes for the local agent server: `GET
 * /api/first-run/status`, `GET /api/first-run/options`, `GET /api/wallet/keys`
 * (first-run only), and `POST /api/first-run`.
 *
 * The POST handler is the single writer that turns the onboarding form into a
 * persisted `ElizaConfig`: character persona, UI preset/avatar/voice/theme,
 * deployment target and service routing, provider credentials, connectors
 * (Telegram/Discord/WhatsApp/Twilio/Blooio), GitHub token, inventory RPC keys,
 * sandbox mode, and the `meta.firstRunComplete` marker; it also mirrors the
 * character onto the live runtime and the agent DB row.
 *
 * Every route requires an exact OWNER principal. Credential-free trusted
 * loopback is admitted only as a provisional owner while durable onboarding is
 * incomplete; mutations publish only after an exact config commit.
 */
import type http from "node:http";
import {
  type Agent,
  type AgentRuntime,
  logger,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  asRecord,
  type DeploymentTargetConfig,
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
  normalizeDeploymentTargetConfig,
  normalizeFirstRunCredentialInputs,
  normalizeLinkedAccountFlagsConfig,
  normalizeServiceRoutingConfig,
  PostFirstRunRequestSchema,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import type { Vault } from "@elizaos/vault";
import {
  configFileExists,
  type ElizaConfig,
  type ElizaConfigCommitResult,
  loadElizaConfig,
} from "../config/config.ts";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import {
  applyCanonicalFirstRunConfig,
  applyFirstRunCredentialPersistence,
} from "./provider-switch-config.ts";
import type { WalletKeyProvisionResult } from "./server-helpers-config.ts";
import {
  beginWalletKeyPersistence,
  type WalletKeyPersistenceTransaction,
} from "./wallet-key-persistence.ts";

// ---------------------------------------------------------------------------
// Cloud container character default bootstrapping
// ---------------------------------------------------------------------------

/**
 * Cloud-provisioned containers skip first-run entirely, which means the
 * character preset (ui.presetId, ui.avatarIndex) and the matching TTS voice
 * are never written to the config file.  This helper ensures that the first
 * GET /api/first-run/status from a cloud container writes sensible defaults
 * so the frontend hydrates with the correct character and voice.
 *
 * Only runs once: subsequent requests see ui.presetId already set and bail.
 */
let _cloudDefaultsApplied = false;

function normalizeCanonicalRuntimeConfigForCurrentServer(args: {
  deploymentTarget: DeploymentTargetConfig | null;
  serviceRouting: ServiceRoutingConfig | null;
  credentialInputs: ReturnType<typeof normalizeFirstRunCredentialInputs>;
}): {
  deploymentTarget: DeploymentTargetConfig | null;
  serviceRouting: ServiceRoutingConfig | null;
} {
  const llmRoute = args.serviceRouting?.llmText;
  if (
    args.deploymentTarget?.runtime !== "remote" ||
    args.deploymentTarget.provider !== "remote" ||
    llmRoute?.transport !== "remote" ||
    !llmRoute.backend ||
    !args.credentialInputs?.llmApiKey
  ) {
    return {
      deploymentTarget: args.deploymentTarget,
      serviceRouting: args.serviceRouting,
    };
  }

  return {
    deploymentTarget: { runtime: "local" },
    serviceRouting: {
      ...(args.serviceRouting ?? {}),
      llmText: {
        backend: llmRoute.backend,
        transport: "direct",
        ...(llmRoute.primaryModel
          ? { primaryModel: llmRoute.primaryModel }
          : {}),
      },
    },
  };
}

function ensureCloudContainerCharacterDefaults(
  ctx: FirstRunRouteContext,
): void {
  if (_cloudDefaultsApplied) return;

  let config: ElizaConfig;
  try {
    config = loadElizaConfig();
  } catch {
    return; // No config file yet — nothing to patch
  }

  const ui = (config.ui ?? {}) as Record<string, unknown>;
  if (ui.presetId) {
    // Already has a character preset — previous first-run or manual config
    _cloudDefaultsApplied = true;
    return;
  }

  // Resolve the default style preset for the configured language
  const language = ctx.resolveConfiguredCharacterLanguage(config, ctx.req);
  const presets = ctx.getStylePresets(language) as Array<{
    id: string;
    name: string;
    avatarIndex: number;
    voicePresetId?: string;
    bio?: string[];
    system?: string;
    style?: unknown;
    adjectives?: string[];
    topics?: string[];
    postExamples?: string[];
    messageExamples?: unknown[];
  }>;
  const defaultPreset = presets[0];
  if (!defaultPreset) {
    _cloudDefaultsApplied = true;
    return;
  }

  // Apply the default character to config
  if (!config.ui) (config as Record<string, unknown>).ui = {};
  const configUi = config.ui as Record<string, unknown>;
  configUi.presetId = defaultPreset.id;
  configUi.avatarIndex = defaultPreset.avatarIndex;
  if (!configUi.assistant || typeof configUi.assistant !== "object") {
    configUi.assistant = {};
  }
  const assistant = configUi.assistant as Record<string, unknown>;
  if (!assistant.name) {
    assistant.name = defaultPreset.name;
  }

  // Apply the matching voice preset so TTS uses the correct voice.
  // First try the standard path (requires ELEVENLABS_API_KEY for direct mode).
  ctx.applyFirstRunVoicePreset(
    config,
    { presetId: defaultPreset.id, avatarIndex: defaultPreset.avatarIndex },
    language,
  );
  // Cloud containers typically use cloud-proxy TTS without a direct API key.
  // If applyFirstRunVoicePreset bailed (no ELEVENLABS_API_KEY), write the
  // voice config anyway so resolveCharacterVoiceConfigFromAppConfig on the
  // client picks up the correct voiceId via the ui.presetId -> preset lookup.
  // The client-side voice resolver reads config.ui.presetId and maps it to the
  // character's voicePresetId, so having presetId set is sufficient.

  // Ensure serviceRouting is set for cloud inference so the cloud topology
  // resolver recognises this as a cloud-inference container and keeps the
  // ELIZAOS_CLOUD_* env vars alive (applyCloudConfigToEnv deletes them when
  // shouldLoadPlugin is false).
  const configRecord = config as Record<string, unknown>;
  if (!configRecord.serviceRouting) {
    configRecord.serviceRouting = {
      llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      tts: { backend: "elizacloud", transport: "cloud-proxy" },
    };
  }

  // Ensure agent list has the default character's personality
  if (!config.agents || typeof config.agents !== "object") {
    (config as Record<string, unknown>).agents = {};
  }
  const agents = config.agents as NonNullable<typeof config.agents>;
  if (!Array.isArray(agents.list) || agents.list.length === 0) {
    (agents as Record<string, unknown>).list = [{ id: "main", default: true }];
  }
  const agentEntry = (agents.list as Record<string, unknown>[])[0];
  if (!agentEntry.name && defaultPreset.name) {
    agentEntry.name = defaultPreset.name;
  }
  if (!agentEntry.bio && defaultPreset.bio) {
    agentEntry.bio = defaultPreset.bio;
  }
  if (!agentEntry.system && defaultPreset.system) {
    agentEntry.system = defaultPreset.system;
  }

  try {
    ctx.saveElizaConfig(config);
    logger.info(
      `[first-run] Applied default character preset "${defaultPreset.id}" for cloud container`,
    );
  } catch (err) {
    logger.warn(
      `[first-run] Failed to persist cloud container character defaults: ${err}`,
    );
  }
  _cloudDefaultsApplied = true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FirstRunRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: FirstRunServerState;
  authorization: AgentHttpRequestAuthorization;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  // Server.ts helpers
  isCloudProvisionedContainer: () => boolean;
  hasPersistedFirstRunState: (config: ElizaConfig) => boolean;
  provisionWalletKeysInEnvAndConfig: (
    config: ElizaConfig,
    environment?: NodeJS.ProcessEnv,
  ) => WalletKeyProvisionResult;
  walletVault: Vault | null;
  pickRandomNames: (count: number) => string[];
  getStylePresets: (lang: string) => unknown[];
  getProviderOptions: () => unknown[];
  getCloudProviderOptions: () => unknown[];
  getModelOptions: () => unknown;
  getInventoryProviderOptions: () => unknown[];
  resolveConfiguredCharacterLanguage: (
    config: ElizaConfig,
    req: http.IncomingMessage,
  ) => string;
  normalizeCharacterLanguage: (lang: string | undefined) => string;
  readUiLanguageHeader: (
    req: http.IncomingMessage,
  ) => string | null | undefined;
  applyFirstRunVoicePreset: (
    config: ElizaConfig,
    body: Record<string, unknown>,
    language: string,
  ) => void;
  saveElizaConfig: (config: ElizaConfig) => void;
  commitElizaConfig: (config: ElizaConfig) => ElizaConfigCommitResult;
}

export interface FirstRunServerState {
  config: ElizaConfig;
  runtime: AgentRuntime | null;
  agentName: string;
  adminEntityId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: unknown;
  chatConnectionPromise: Promise<void> | null;
}

const activeFirstRunMutations = new WeakSet<object>();
const ownedFirstRunMutationContexts = new WeakSet<object>();

interface FirstRunSubmissionTransaction {
  walletPersistence: WalletKeyPersistenceTransaction | null;
  persistedAgent: Agent | null | undefined;
  databaseUpdated: boolean;
  durableCommit: ElizaConfigCommitResult | null;
}

const firstRunSubmissionTransactions = new WeakMap<
  object,
  FirstRunSubmissionTransaction
>();

function applyEnvironmentPlan(
  original: NodeJS.ProcessEnv,
  planned: NodeJS.ProcessEnv,
): void {
  for (const key of Object.keys(original)) {
    if (!(key in planned)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(planned)) {
    if (value !== undefined && original[key] !== value)
      process.env[key] = value;
  }
}

function replaceRecord(target: object, source: object): void {
  const mutable = target as Record<string, unknown>;
  for (const key of Object.keys(mutable)) delete mutable[key];
  Object.assign(mutable, structuredClone(source));
}

function rejectNonOwner(ctx: FirstRunRouteContext): boolean {
  if (ctx.authorization.ok && ctx.authorization.role === "OWNER") return false;
  ctx.error(
    ctx.res,
    ctx.authorization.ok ? "Owner role required" : "Unauthorized",
    ctx.authorization.ok ? 403 : 401,
  );
  return true;
}

function loadCanonicalFirstRunConfig(ctx: FirstRunRouteContext): ElizaConfig {
  return configFileExists()
    ? loadElizaConfig()
    : structuredClone(ctx.state.config);
}

function requireCanonicalFirstRunConfig(
  ctx: FirstRunRouteContext,
): ElizaConfig | null {
  try {
    return loadCanonicalFirstRunConfig(ctx);
  } catch (cause) {
    // error-policy:J1 the HTTP boundary fails closed when durable onboarding
    // state cannot be loaded and reports the underlying read failure.
    ctx.state.runtime?.reportError("first-run.config.reload", cause);
    ctx.error(ctx.res, "First-run setup is unavailable", 503);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

async function handleFirstRunRoutesInner(
  ctx: FirstRunRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  const isStatus = method === "GET" && pathname === "/api/first-run/status";
  const isOptions = method === "GET" && pathname === "/api/first-run/options";
  const isWallet = method === "GET" && pathname === "/api/wallet/keys";
  const isSubmit = method === "POST" && pathname === "/api/first-run";
  if (!isStatus && !isOptions && !isWallet && !isSubmit) return false;
  if (rejectNonOwner(ctx)) return true;

  // ── GET /api/first-run/status ──────────────────────────────────────
  if (isStatus) {
    if (ctx.isCloudProvisionedContainer()) {
      // Ensure the config file has the default character preset + voice so
      // the frontend hydrates with the correct character instead of a bare
      // fallback.  This is idempotent and only writes once.
      ensureCloudContainerCharacterDefaults(ctx);
      json(res, { complete: true, cloudProvisioned: true });
      return true;
    }

    let config = state.config;
    let complete = configFileExists() && ctx.hasPersistedFirstRunState(config);

    if (!complete && configFileExists()) {
      try {
        config = loadElizaConfig();
        complete = ctx.hasPersistedFirstRunState(config);
        if (complete) {
          state.config = config;
        }
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to refresh config for first-run status: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    json(res, { complete });
    return true;
  }

  // ── GET /api/wallet/keys (first-run only) ─────────────────────────
  if (isWallet) {
    const canonicalConfig = requireCanonicalFirstRunConfig(ctx);
    if (!canonicalConfig) return true;
    if (ctx.hasPersistedFirstRunState(canonicalConfig)) {
      error(res, "First-run setup is already complete", 409);
      return true;
    }
    if (activeFirstRunMutations.has(state)) {
      error(res, "First-run setup is already in progress", 409);
      return true;
    }
    activeFirstRunMutations.add(state);
    ownedFirstRunMutationContexts.add(ctx);
    let walletPersistence: WalletKeyPersistenceTransaction | null = null;

    try {
      logger.warn(
        `[eliza-api] Wallet keys requested during first-run (ip=${req.socket.remoteAddress ?? "unknown"})`,
      );
      const originalEnvironment = { ...process.env };
      const plannedEnvironment = { ...process.env };
      const stagedConfig = structuredClone(canonicalConfig);
      const wallet = ctx.provisionWalletKeysInEnvAndConfig(
        stagedConfig,
        plannedEnvironment,
      );
      if (!wallet.ok) {
        error(res, "Wallet key generation is unavailable", 503);
        return true;
      }

      walletPersistence = await beginWalletKeyPersistence(
        stagedConfig,
        wallet,
        ctx.walletVault,
        "first-run-wallet",
      );
      const commit = await walletPersistence.commitConfig(
        stagedConfig,
        ctx.commitElizaConfig,
      );
      if (commit.status === "not-published") {
        logger.error(
          { err: commit.cause },
          "[first-run] Wallet configuration was not persisted",
        );
        error(res, "Wallet key persistence is unavailable", 503);
        return true;
      }
      if (commit.status === "uncertain") {
        state.runtime?.reportError("first-run.wallet.commit", commit.cause, {
          commitStatus: commit.status,
        });
        error(res, "Wallet key persistence state is uncertain", 503);
        return true;
      }

      applyEnvironmentPlan(originalEnvironment, plannedEnvironment);
      state.config = stagedConfig;
      const maskKey = (key: string): string =>
        key.length <= 4 ? "****" : `****${key.slice(-4)}`;
      json(res, {
        evmPrivateKey: maskKey(wallet.evmPrivateKey),
        evmAddress: wallet.evmAddress,
        solanaPrivateKey: maskKey(wallet.solanaPrivateKey),
        solanaAddress: wallet.solanaAddress,
      });
      return true;
    } catch (cause) {
      // error-policy:J1 the wallet HTTP boundary retries proven-safe
      // compensation before returning a stable unavailable response.
      if (walletPersistence) {
        try {
          await walletPersistence.compensate();
        } catch (rollbackCause) {
          // error-policy:J7 retain the primary transaction failure while
          // reporting a second compensation failure for owner diagnostics.
          state.runtime?.reportError(
            "first-run.wallet.vault-compensation",
            rollbackCause,
          );
        }
      }
      state.runtime?.reportError("first-run.wallet.persistence", cause);
      logger.error({ err: cause }, "[first-run] Wallet provisioning failed");
      error(res, "Wallet key persistence is unavailable", 503);
      return true;
    } finally {
      activeFirstRunMutations.delete(state);
    }
  }

  // ── GET /api/first-run/options ─────────────────────────────────────
  if (isOptions) {
    const canonicalConfig = requireCanonicalFirstRunConfig(ctx);
    if (!canonicalConfig) return true;
    if (ctx.hasPersistedFirstRunState(canonicalConfig)) {
      error(res, "First-run setup is already complete", 409);
      return true;
    }
    json(res, {
      names: ctx.pickRandomNames(5),
      styles: ctx.getStylePresets(
        ctx.resolveConfiguredCharacterLanguage(canonicalConfig, req),
      ),
      providers: ctx.getProviderOptions(),
      cloudProviders: ctx.getCloudProviderOptions(),
      models: ctx.getModelOptions(),
      inventoryProviders: ctx.getInventoryProviderOptions(),
      sharedStyleRules: "Keep responses brief. Be helpful and concise.",
      githubOAuthAvailable: Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim()),
    });
    return true;
  }

  // ── POST /api/first-run ────────────────────────────────────────────
  if (isSubmit) {
    const canonicalConfig = requireCanonicalFirstRunConfig(ctx);
    if (!canonicalConfig) return true;
    if (ctx.hasPersistedFirstRunState(canonicalConfig)) {
      error(res, "First-run setup is already complete", 409);
      return true;
    }
    if (activeFirstRunMutations.has(state)) {
      error(res, "First-run setup is already in progress", 409);
      return true;
    }
    activeFirstRunMutations.add(state);
    ownedFirstRunMutationContexts.add(ctx);
    const originalEnvironment = { ...process.env };
    const plannedEnvironment = { ...process.env };
    const transaction: FirstRunSubmissionTransaction = {
      walletPersistence: null,
      persistedAgent: undefined,
      databaseUpdated: false,
      durableCommit: null,
    };
    firstRunSubmissionTransactions.set(ctx, transaction);
    const rawFirstRun = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawFirstRun === null) return true;
    const parsedFirstRun = PostFirstRunRequestSchema.safeParse(rawFirstRun);
    if (!parsedFirstRun.success) {
      error(
        res,
        parsedFirstRun.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedFirstRun.data as Record<string, unknown>;

    const config = structuredClone(canonicalConfig);
    const configuredLanguage = ctx.normalizeCharacterLanguage(
      (body.language as string | undefined) ??
        ctx.readUiLanguageHeader(req) ??
        config.ui?.language,
    );

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.workspace = resolveDefaultAgentWorkspaceDir();
    const firstRunAdminEntityId = stringToUuid(
      `${(body.name as string).trim()}-admin-entity`,
    ) as UUID;
    config.agents.defaults.adminEntityId = firstRunAdminEntityId;

    if (!config.agents.list) config.agents.list = [];
    if (config.agents.list.length === 0) {
      config.agents.list.push({ id: "main", default: true });
    }
    const agent = config.agents.list[0] as Record<string, unknown>;
    agent.name = (body.name as string).trim();
    agent.workspace = resolveDefaultAgentWorkspaceDir();
    let normalizedMessageExamples:
      | Array<{
          examples: { name: string; content: { text: string } }[];
        }>
      | undefined;
    if (body.bio) agent.bio = body.bio as string[];
    if (body.systemPrompt) agent.system = body.systemPrompt as string;
    if (body.style)
      agent.style = body.style as {
        all?: string[];
        chat?: string[];
        post?: string[];
      };
    if (body.adjectives) agent.adjectives = body.adjectives as string[];
    if (body.topics) {
      agent.topics = body.topics as string[];
    }
    if (body.postExamples) agent.postExamples = body.postExamples as string[];
    if (body.messageExamples) {
      const raw = body.messageExamples as unknown[];
      normalizedMessageExamples = raw.map((item) => {
        if (
          item &&
          typeof item === "object" &&
          "examples" in (item as Record<string, unknown>)
        ) {
          return item as {
            examples: { name: string; content: { text: string } }[];
          };
        }
        const arr = item as {
          user?: string;
          name?: string;
          content: { text: string };
        }[];
        return {
          examples: arr.map((m) => ({
            name: m.name ?? m.user ?? "",
            content: m.content,
          })),
        };
      });
      agent.messageExamples = normalizedMessageExamples;
    }

    if (!config.ui) {
      config.ui = {};
    }
    config.ui.assistant = {
      ...(config.ui.assistant ?? {}),
      name: agent.name as string,
    };
    if (
      typeof body.avatarIndex === "number" &&
      Number.isFinite(body.avatarIndex)
    ) {
      config.ui.avatarIndex = Number(body.avatarIndex);
    }
    config.ui.language = configuredLanguage;
    if (typeof body.presetId === "string" && body.presetId.trim()) {
      config.ui.presetId = body.presetId.trim();
    }
    ctx.applyFirstRunVoicePreset(config, body, configuredLanguage);

    // ── Theme preference ──────────────────────────────────────────────────
    if (body.theme) {
      if (!config.ui) config.ui = {};
      config.ui.theme = body.theme as
        | "eliza"
        | "qt314"
        | "web2000"
        | "programmer"
        | "haxor"
        | "psycho";
    }

    const explicitDeploymentTargetRequested = Object.hasOwn(
      body,
      "deploymentTarget",
    );
    const explicitDeploymentTarget = explicitDeploymentTargetRequested
      ? normalizeDeploymentTargetConfig(body.deploymentTarget)
      : null;
    if (explicitDeploymentTargetRequested && !explicitDeploymentTarget) {
      error(res, "Invalid deploymentTarget", 400);
      return true;
    }
    const explicitLinkedAccountsRequested = Object.hasOwn(
      body,
      "linkedAccounts",
    );
    const explicitLinkedAccounts = explicitLinkedAccountsRequested
      ? normalizeLinkedAccountFlagsConfig(body.linkedAccounts)
      : null;
    const explicitServiceRoutingRequested = Object.hasOwn(
      body,
      "serviceRouting",
    );
    const explicitServiceRouting = explicitServiceRoutingRequested
      ? normalizeServiceRoutingConfig(body.serviceRouting)
      : null;
    const explicitCredentialInputsRequested = Object.hasOwn(
      body,
      "credentialInputs",
    );
    const explicitCredentialInputs = explicitCredentialInputsRequested
      ? normalizeFirstRunCredentialInputs(body.credentialInputs)
      : null;
    if (explicitCredentialInputsRequested && !explicitCredentialInputs) {
      error(res, "Invalid credentialInputs", 400);
      return true;
    }
    const hasCanonicalRuntimeConfig =
      explicitDeploymentTargetRequested ||
      explicitLinkedAccountsRequested ||
      explicitServiceRoutingRequested ||
      explicitCredentialInputsRequested;
    const normalizedCanonicalRuntimeConfig =
      normalizeCanonicalRuntimeConfigForCurrentServer({
        deploymentTarget: explicitDeploymentTarget,
        serviceRouting: explicitServiceRouting,
        credentialInputs: explicitCredentialInputs,
      });
    const normalizedDeploymentTarget =
      normalizedCanonicalRuntimeConfig.deploymentTarget;
    const normalizedServiceRouting =
      normalizedCanonicalRuntimeConfig.serviceRouting;

    // ── Sandbox mode (from first-run runtime setup: off / light / standard / max)
    const sandboxMode = (body.sandboxMode as string) || "off";
    if (sandboxMode !== "off") {
      if (!config.agents) config.agents = {};
      if (!config.agents.defaults) config.agents.defaults = {};
      if (!(config.agents.defaults as Record<string, unknown>).sandbox) {
        (config.agents.defaults as Record<string, unknown>).sandbox = {};
      }
      (
        (config.agents.defaults as Record<string, unknown>).sandbox as Record<
          string,
          unknown
        >
      ).mode = sandboxMode;
      logger.info(`[eliza-api] Sandbox mode set to: ${sandboxMode}`);
    }

    if (hasCanonicalRuntimeConfig) {
      applyCanonicalFirstRunConfig(config, {
        deploymentTarget: normalizedDeploymentTarget,
        linkedAccounts: explicitLinkedAccounts,
        serviceRouting: normalizedServiceRouting,
        clearRoutes:
          explicitServiceRoutingRequested && !normalizedServiceRouting?.llmText
            ? ["llmText"]
            : [],
      });

      await applyFirstRunCredentialPersistence(config, {
        credentialInputs: explicitCredentialInputs,
        deploymentTarget:
          normalizedDeploymentTarget ??
          normalizeDeploymentTargetConfig(config.deploymentTarget),
        serviceRouting:
          normalizedServiceRouting ??
          normalizeServiceRoutingConfig(config.serviceRouting),
        environment: plannedEnvironment,
      });

      delete plannedEnvironment.ELIZAOS_CLOUD_ENABLED;
      delete plannedEnvironment.ELIZAOS_CLOUD_NANO_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_MEDIUM_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_SMALL_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_LARGE_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_MEGA_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
      delete plannedEnvironment.ELIZAOS_CLOUD_PLANNER_MODEL;

      if (config.models && typeof config.models === "object") {
        const legacyModels = config.models as Record<string, unknown>;
        delete legacyModels.nano;
        delete config.models.small;
        delete legacyModels.medium;
        delete config.models.large;
        delete legacyModels.mega;
      }

      if (
        !isCloudInferenceSelectedInConfig(config as Record<string, unknown>)
      ) {
        delete plannedEnvironment.ELIZAOS_CLOUD_API_KEY;
      }
    }
    if (hasCanonicalRuntimeConfig && config.agents.defaults.model) {
      delete config.agents.defaults.model.primary;
    }

    // ── GitHub token ────────────────────────────────────────────────────
    if (
      body.githubToken &&
      typeof body.githubToken === "string" &&
      body.githubToken.trim()
    ) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).GITHUB_TOKEN =
        body.githubToken.trim();
      plannedEnvironment.GITHUB_TOKEN = body.githubToken.trim();
    }

    // ── Connectors (Telegram, Discord, WhatsApp, Twilio, Blooio) ────────
    if (!config.connectors) config.connectors = {};
    const explicitConnectors = asRecord(body.connectors);
    if (explicitConnectors) {
      for (const [connectorName, connectorValue] of Object.entries(
        explicitConnectors,
      )) {
        const nextConnector = asRecord(connectorValue);
        if (!nextConnector) {
          continue;
        }
        const currentConnector = asRecord(config.connectors[connectorName]);
        config.connectors[connectorName] = {
          ...(currentConnector ?? {}),
          ...nextConnector,
        } as import("../config/types.eliza.ts").ConnectorConfig;
      }
    }
    if (
      body.telegramToken &&
      typeof body.telegramToken === "string" &&
      body.telegramToken.trim()
    ) {
      config.connectors.telegram = { botToken: body.telegramToken.trim() };
    }
    if (
      body.discordToken &&
      typeof body.discordToken === "string" &&
      body.discordToken.trim()
    ) {
      config.connectors.discord = { token: body.discordToken.trim() };
    }
    if (
      body.whatsappSessionPath &&
      typeof body.whatsappSessionPath === "string" &&
      body.whatsappSessionPath.trim()
    ) {
      config.connectors.whatsapp = {
        sessionPath: body.whatsappSessionPath.trim(),
      };
    }
    if (
      body.twilioAccountSid &&
      typeof body.twilioAccountSid === "string" &&
      body.twilioAccountSid.trim() &&
      body.twilioAuthToken &&
      typeof body.twilioAuthToken === "string" &&
      body.twilioAuthToken.trim()
    ) {
      if (!config.env) config.env = {};
      (config.env as Record<string, string>).TWILIO_ACCOUNT_SID = (
        body.twilioAccountSid as string
      ).trim();
      (config.env as Record<string, string>).TWILIO_AUTH_TOKEN = (
        body.twilioAuthToken as string
      ).trim();
      plannedEnvironment.TWILIO_ACCOUNT_SID = (
        body.twilioAccountSid as string
      ).trim();
      plannedEnvironment.TWILIO_AUTH_TOKEN = (
        body.twilioAuthToken as string
      ).trim();
      if (
        body.twilioPhoneNumber &&
        typeof body.twilioPhoneNumber === "string" &&
        body.twilioPhoneNumber.trim()
      ) {
        (config.env as Record<string, string>).TWILIO_PHONE_NUMBER = (
          body.twilioPhoneNumber as string
        ).trim();
        plannedEnvironment.TWILIO_PHONE_NUMBER = (
          body.twilioPhoneNumber as string
        ).trim();
      }
    }
    if (
      body.blooioApiKey &&
      typeof body.blooioApiKey === "string" &&
      body.blooioApiKey.trim()
    ) {
      if (!config.env) config.env = {};
      const trimmedKey = (body.blooioApiKey as string).trim();
      (config.env as Record<string, string>).BLOOIO_API_KEY = trimmedKey;
      plannedEnvironment.BLOOIO_API_KEY = trimmedKey;

      const blooioConnector: Record<string, string> = { apiKey: trimmedKey };

      if (
        body.blooioPhoneNumber &&
        typeof body.blooioPhoneNumber === "string" &&
        body.blooioPhoneNumber.trim()
      ) {
        const trimmedPhone = (body.blooioPhoneNumber as string).trim();
        (config.env as Record<string, string>).BLOOIO_PHONE_NUMBER =
          trimmedPhone;
        plannedEnvironment.BLOOIO_PHONE_NUMBER = trimmedPhone;
        blooioConnector.fromNumber = trimmedPhone;
      }

      config.connectors.blooio = blooioConnector;
    }

    const explicitFeatures = asRecord(body.features);
    if (explicitFeatures) {
      config.features = {
        ...(asRecord(config.features) ?? {}),
        ...explicitFeatures,
      } as NonNullable<ElizaConfig["features"]>;
    }

    // ── Inventory / RPC providers ─────────────────────────────────────────
    if (Array.isArray(body.inventoryProviders)) {
      if (!config.env) config.env = {};
      const allInventory = ctx.getInventoryProviderOptions() as Array<{
        id: string;
        rpcProviders: Array<{ id: string; envKey?: string }>;
      }>;
      for (const inv of body.inventoryProviders as Array<{
        chain: string;
        rpcProvider: string;
        rpcApiKey?: string;
      }>) {
        const chainDef = allInventory.find((ip) => ip.id === inv.chain);
        if (!chainDef) continue;
        const rpcDef = chainDef.rpcProviders.find(
          (rp) => rp.id === inv.rpcProvider,
        );
        if (rpcDef?.envKey && inv.rpcApiKey) {
          (config.env as Record<string, string>)[rpcDef.envKey] = inv.rpcApiKey;
          plannedEnvironment[rpcDef.envKey] = inv.rpcApiKey;
        }
      }
    }

    // ── Ensure wallet keys exist so inventory can resolve addresses ───────
    const wallet = ctx.provisionWalletKeysInEnvAndConfig(
      config,
      plannedEnvironment,
    );
    if (!wallet.ok) {
      error(res, "Wallet key generation is unavailable", 503);
      return true;
    }
    transaction.walletPersistence = await beginWalletKeyPersistence(
      config,
      wallet,
      ctx.walletVault,
      "first-run-submit",
    );

    if (!config.meta) {
      config.meta = {};
    }
    config.meta.firstRunComplete = true;

    const stagedRuntimeCharacter = state.runtime
      ? structuredClone(state.runtime.character)
      : null;
    if (state.runtime && stagedRuntimeCharacter) {
      const runtimeCharacter = stagedRuntimeCharacter;
      const agentTopics = agent.topics as string[] | undefined;
      runtimeCharacter.name = (agent.name as string) ?? runtimeCharacter.name;
      if (Array.isArray(agent.bio)) {
        runtimeCharacter.bio = [...(agent.bio as string[])];
      }
      if (typeof agent.system === "string" && agent.system) {
        runtimeCharacter.system = agent.system;
      }
      if (Array.isArray(agent.adjectives)) {
        runtimeCharacter.adjectives = [...(agent.adjectives as string[])];
      }
      if (Array.isArray(agentTopics)) {
        runtimeCharacter.topics = [...agentTopics];
      }
      if (agent.style) {
        runtimeCharacter.style = JSON.parse(JSON.stringify(agent.style));
      }
      if (normalizedMessageExamples) {
        runtimeCharacter.messageExamples = normalizedMessageExamples;
      }
      if (Array.isArray(agent.postExamples)) {
        runtimeCharacter.postExamples = [...(agent.postExamples as string[])];
      }

      transaction.persistedAgent = await state.runtime.getAgent(
        state.runtime.agentId,
      );
      const updated = await state.runtime.updateAgent(state.runtime.agentId, {
        name: runtimeCharacter.name,
        metadata: {
          ...transaction.persistedAgent?.metadata,
          character: {
            name: runtimeCharacter.name,
            bio: runtimeCharacter.bio,
            system: runtimeCharacter.system,
            adjectives: runtimeCharacter.adjectives,
            topics: runtimeCharacter.topics,
            style: runtimeCharacter.style,
            messageExamples: runtimeCharacter.messageExamples,
            postExamples: runtimeCharacter.postExamples,
          },
        },
      });
      if (!updated) {
        throw new Error("First-run character database update was rejected");
      }
      transaction.databaseUpdated = true;
    }

    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    transaction.durableCommit =
      await transaction.walletPersistence.commitConfig(
        config,
        ctx.commitElizaConfig,
      );
    if (transaction.durableCommit.status === "not-published") {
      throw transaction.durableCommit.cause;
    }
    if (transaction.durableCommit.status === "uncertain") {
      state.runtime?.reportError(
        "first-run.submit.commit",
        transaction.durableCommit.cause,
        {
          commitStatus: transaction.durableCommit.status,
        },
      );
      error(res, "First-run persistence state is uncertain", 503);
      return true;
    }

    applyEnvironmentPlan(originalEnvironment, plannedEnvironment);
    state.config = config;
    state.agentName = (body.name as string) ?? state.agentName;
    state.adminEntityId = firstRunAdminEntityId;
    state.chatUserId = firstRunAdminEntityId;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;
    if (state.runtime && stagedRuntimeCharacter) {
      replaceRecord(state.runtime.character, stagedRuntimeCharacter);
    }

    const resolvedRuntime =
      normalizeDeploymentTargetConfig(config.deploymentTarget)?.runtime ??
      "local";
    logger.info(
      `[eliza-api] First run complete for agent "${body.name}" (runtime: ${resolvedRuntime})`,
    );
    json(res, { ok: true });
    return true;
  }

  return false;
}

async function compensateFirstRunSubmission(
  ctx: FirstRunRouteContext,
  transaction: FirstRunSubmissionTransaction,
): Promise<void> {
  const { state } = ctx;
  if (transaction.durableCommit?.status === "uncertain") return;
  if (transaction.databaseUpdated && state.runtime) {
    try {
      const restored = transaction.persistedAgent
        ? await state.runtime.updateAgent(state.runtime.agentId, {
            name: transaction.persistedAgent.name,
            metadata: transaction.persistedAgent.metadata,
          })
        : await state.runtime.deleteAgent(state.runtime.agentId);
      if (!restored) throw new Error("database compensation was rejected");
    } catch (rollbackCause) {
      // error-policy:J7 a failed compensation is reported without masking the
      // original persistence failure returned by the route boundary.
      state.runtime.reportError(
        "first-run.submit.database-compensation",
        rollbackCause,
      );
    }
  }
  if (transaction.walletPersistence) {
    try {
      await transaction.walletPersistence.compensate();
    } catch (rollbackCause) {
      // error-policy:J7 preserve the primary failure while exposing a vault
      // rollback failure through the runtime diagnostics channel.
      state.runtime?.reportError(
        "first-run.submit.vault-compensation",
        rollbackCause,
      );
    }
  }
}

/** Enforce transaction compensation and lock release around route dispatch. */
export async function handleFirstRunRoutes(
  ctx: FirstRunRouteContext,
): Promise<boolean> {
  try {
    return await handleFirstRunRoutesInner(ctx);
  } catch (cause) {
    // error-policy:J1 onboarding is an HTTP boundary; collaborator failures
    // become a stable unavailable response after proven-safe compensation.
    const transaction = firstRunSubmissionTransactions.get(ctx);
    if (!transaction) throw cause;
    await compensateFirstRunSubmission(ctx, transaction);
    ctx.state.runtime?.reportError("first-run.submit.transaction", cause, {
      durableCommitStatus: transaction.durableCommit?.status ?? "not-started",
    });
    logger.error(
      { err: cause },
      "[first-run] Failed to commit onboarding configuration",
    );
    ctx.error(ctx.res, "First-run setup is unavailable", 503);
    return true;
  } finally {
    if (ownedFirstRunMutationContexts.has(ctx)) {
      activeFirstRunMutations.delete(ctx.state);
      ownedFirstRunMutationContexts.delete(ctx);
      firstRunSubmissionTransactions.delete(ctx);
    }
  }
}
