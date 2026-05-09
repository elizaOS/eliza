import type http from "node:http";
import { logger, stringToUuid, type UUID } from "@elizaos/core";
import {
  asRecord,
  type DeploymentTargetConfig,
  isCloudInferenceSelectedInConfig,
  migrateLegacyRuntimeConfig,
  normalizeDeploymentTargetConfig,
  normalizeLinkedAccountFlagsConfig,
  normalizeOnboardingCredentialInputs,
  normalizeServiceRoutingConfig,
  type ServiceRoutingConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import { configFileExists, loadElizaConfig } from "../config/config.js";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.js";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  applyCanonicalOnboardingConfig,
  applyOnboardingCredentialPersistence,
} from "./provider-switch-config.js";

// ---------------------------------------------------------------------------
// Cloud container character default bootstrapping
// ---------------------------------------------------------------------------

/**
 * Cloud-provisioned containers skip onboarding entirely, which means the
 * character preset (ui.presetId, ui.avatarIndex) and the matching TTS voice
 * are never written to the config file.  This helper ensures that the first
 * GET /api/onboarding/status from a cloud container writes sensible defaults
 * so the frontend hydrates with the correct character and voice.
 *
 * Only runs once: subsequent requests see ui.presetId already set and bail.
 */
let _cloudDefaultsApplied = false;

function normalizeCanonicalRuntimeConfigForCurrentServer(args: {
  deploymentTarget: DeploymentTargetConfig | null;
  serviceRouting: ServiceRoutingConfig | null;
  credentialInputs: ReturnType<typeof normalizeOnboardingCredentialInputs>;
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
  ctx: OnboardingRouteContext,
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
    // Already has a character preset — previous onboarding or manual config
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
  ctx.applyOnboardingVoicePreset(
    config,
    { presetId: defaultPreset.id, avatarIndex: defaultPreset.avatarIndex },
    language,
  );
  // Cloud containers typically use cloud-proxy TTS without a direct API key.
  // If applyOnboardingVoicePreset bailed (no ELEVENLABS_API_KEY), write the
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
      `[onboarding] Applied default character preset "${defaultPreset.id}" for cloud container`,
    );
  } catch (err) {
    logger.warn(
      `[onboarding] Failed to persist cloud container character defaults: ${err}`,
    );
  }
  _cloudDefaultsApplied = true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OnboardingRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: OnboardingServerState;
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  // Server.ts helpers
  isCloudProvisionedContainer: () => boolean;
  hasPersistedOnboardingState: (config: ElizaConfig) => boolean;
  ensureWalletKeysInEnvAndConfig: (config: ElizaConfig) => boolean;
  getWalletAddresses: () => {
    evmAddress?: string;
    solanaAddress?: string;
  };
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
  readUiLanguageHeader: (req: http.IncomingMessage) => string | null;
  applyOnboardingVoicePreset: (
    config: ElizaConfig,
    body: Record<string, unknown>,
    language: string,
  ) => void;
  saveElizaConfig: (config: ElizaConfig) => void;
}

export interface OnboardingServerState {
  config: ElizaConfig;
  runtime: {
    agentId: string;
    character: Record<string, unknown> & { name: string };
    updateAgent: (...args: unknown[]) => Promise<unknown>;
  } | null;
  agentName: string;
  adminEntityId: UUID | null;
  chatUserId: UUID | null;
  chatConnectionReady: unknown;
  chatConnectionPromise: Promise<void> | null;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleOnboardingRoutes(
  ctx: OnboardingRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, state, json, error, readJsonBody } = ctx;

  // ── GET /api/onboarding/status ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/status") {
    if (ctx.isCloudProvisionedContainer()) {
      // Ensure the config file has the default character preset + voice so
      // the frontend hydrates with the correct character instead of a bare
      // fallback.  This is idempotent and only writes once.
      ensureCloudContainerCharacterDefaults(ctx);
      json(res, { complete: true, cloudProvisioned: true });
      return true;
    }

    let config = state.config;
    let complete =
      configFileExists() && ctx.hasPersistedOnboardingState(config);

    if (!complete && configFileExists()) {
      try {
        config = loadElizaConfig();
        complete = ctx.hasPersistedOnboardingState(config);
        if (complete) {
          state.config = config;
        }
      } catch (err) {
        logger.warn(
          `[eliza-api] Failed to refresh config for onboarding status: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
    json(res, { complete });
    return true;
  }

  // ── GET /api/wallet/keys (onboarding only) ─────────────────────────
  if (method === "GET" && pathname === "/api/wallet/keys") {
    if (ctx.hasPersistedOnboardingState(state.config)) {
      json(
        res,
        { error: "Wallet keys are only available during onboarding" },
        403,
      );
      return true;
    }

    logger.warn(
      `[eliza-api] Wallet keys requested during onboarding (ip=${req.socket?.remoteAddress ?? "unknown"})`,
    );

    ctx.ensureWalletKeysInEnvAndConfig(state.config);
    try {
      ctx.saveElizaConfig(state.config);
    } catch {
      // Non-fatal
    }

    const evmPrivateKey = process.env.EVM_PRIVATE_KEY ?? "";
    const solanaPrivateKey = process.env.SOLANA_PRIVATE_KEY ?? "";
    const addresses = ctx.getWalletAddresses();

    const maskKey = (key: string): string => {
      if (!key || key.length <= 4) return key ? "****" : "";
      return `****${key.slice(-4)}`;
    };

    json(res, {
      evmPrivateKey: maskKey(evmPrivateKey),
      evmAddress: addresses.evmAddress ?? "",
      solanaPrivateKey: maskKey(solanaPrivateKey),
      solanaAddress: addresses.solanaAddress ?? "",
    });
    return true;
  }

  // ── GET /api/onboarding/options ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/options") {
    json(res, {
      names: ctx.pickRandomNames(5),
      styles: ctx.getStylePresets(
        ctx.resolveConfiguredCharacterLanguage(state.config, req),
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

  // ── POST /api/onboarding ────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/onboarding") {
    const body = await readJsonBody<Record<string, unknown>>(req, res);
    if (!body) return true;

    // ── Validate required fields ──────────────────────────────────────────
    if (
      !body.name ||
      typeof body.name !== "string" ||
      !(body.name as string).trim()
    ) {
      error(res, "Missing or invalid agent name", 400);
      return true;
    }
    const hasLegacyOnboardingFields = [
      "connection",
      "runMode",
      "cloudProvider",
      "provider",
      "providerApiKey",
      "primaryModel",
      "nanoModel",
      "smallModel",
      "mediumModel",
      "largeModel",
      "megaModel",
    ].some((key) => Object.hasOwn(body, key));
    if (hasLegacyOnboardingFields) {
      error(
        res,
        "legacy onboarding payloads are no longer supported; send deploymentTarget, linkedAccounts, serviceRouting, and credentialInputs",
        400,
      );
      return true;
    }

    let config = state.config;
    try {
      config = loadElizaConfig();
    } catch (err) {
      logger.warn(
        `[eliza-api] Failed to reload config before onboarding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const configuredLanguage = ctx.normalizeCharacterLanguage(
      (body.language as string | undefined) ??
        ctx.readUiLanguageHeader(req) ??
        config.ui?.language,
    );

    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    config.agents.defaults.workspace = resolveDefaultAgentWorkspaceDir();
    const onboardingAdminEntityId = stringToUuid(
      `${(body.name as string).trim()}-admin-entity`,
    ) as UUID;
    config.agents.defaults.adminEntityId = onboardingAdminEntityId;
    state.adminEntityId = onboardingAdminEntityId;
    state.chatUserId = onboardingAdminEntityId;
    state.chatConnectionReady = null;
    state.chatConnectionPromise = null;

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
    ctx.applyOnboardingVoicePreset(config, body, configuredLanguage);

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
      ? normalizeOnboardingCredentialInputs(body.credentialInputs)
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

    // ── Sandbox mode (from 3-mode onboarding: off / light / standard / max)
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
      applyCanonicalOnboardingConfig(config, {
        deploymentTarget: normalizedDeploymentTarget,
        linkedAccounts: explicitLinkedAccounts,
        serviceRouting: normalizedServiceRouting,
        clearRoutes:
          explicitServiceRoutingRequested && !normalizedServiceRouting?.llmText
            ? ["llmText"]
            : [],
      });

      await applyOnboardingCredentialPersistence(config, {
        credentialInputs: explicitCredentialInputs,
        deploymentTarget:
          normalizedDeploymentTarget ??
          normalizeDeploymentTargetConfig(config.deploymentTarget),
        serviceRouting:
          normalizedServiceRouting ??
          normalizeServiceRoutingConfig(config.serviceRouting),
      });

      delete process.env.ELIZAOS_CLOUD_ENABLED;
      delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
      delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
      delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
      delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
      delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
      delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
      delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
      delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
      delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;

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
        delete process.env.ELIZAOS_CLOUD_API_KEY;
      }
    }
    if (hasCanonicalRuntimeConfig && config.agents?.defaults?.model) {
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
      process.env.GITHUB_TOKEN = body.githubToken.trim();
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
        } as import("../config/types.eliza.js").ConnectorConfig;
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
      process.env.TWILIO_ACCOUNT_SID = (body.twilioAccountSid as string).trim();
      process.env.TWILIO_AUTH_TOKEN = (body.twilioAuthToken as string).trim();
      if (
        body.twilioPhoneNumber &&
        typeof body.twilioPhoneNumber === "string" &&
        body.twilioPhoneNumber.trim()
      ) {
        (config.env as Record<string, string>).TWILIO_PHONE_NUMBER = (
          body.twilioPhoneNumber as string
        ).trim();
        process.env.TWILIO_PHONE_NUMBER = (
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
      process.env.BLOOIO_API_KEY = trimmedKey;

      const blooioConnector: Record<string, string> = { apiKey: trimmedKey };

      if (
        body.blooioPhoneNumber &&
        typeof body.blooioPhoneNumber === "string" &&
        body.blooioPhoneNumber.trim()
      ) {
        const trimmedPhone = (body.blooioPhoneNumber as string).trim();
        (config.env as Record<string, string>).BLOOIO_PHONE_NUMBER =
          trimmedPhone;
        process.env.BLOOIO_PHONE_NUMBER = trimmedPhone;
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
          process.env[rpcDef.envKey] = inv.rpcApiKey;
        }
      }
    }

    // ── Ensure wallet keys exist so inventory can resolve addresses ───────
    ctx.ensureWalletKeysInEnvAndConfig(config);

    if (!config.meta) {
      config.meta = {};
    }
    config.meta.onboardingComplete = true;

    if (state.runtime) {
      const runtimeCharacter = state.runtime.character;
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

      try {
        await state.runtime.updateAgent(state.runtime.agentId, {
          name: runtimeCharacter.name,
          metadata: {
            ...(runtimeCharacter.metadata as
              | Record<string, unknown>
              | undefined),
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
      } catch (err) {
        logger.warn(
          `[character-db] Failed to persist onboarding character to DB: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    state.config = config;
    state.agentName = (body.name as string) ?? state.agentName;
    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    try {
      ctx.saveElizaConfig(config);
    } catch (err) {
      logger.error(
        `[eliza-api] Failed to save config after onboarding: ${err}`,
      );
      error(res, "Failed to save configuration", 500);
      return true;
    }

    if (!configFileExists()) {
      logger.error(
        `[eliza-api] Config file does not exist after save — onboarding data will be lost on restart`,
      );
      error(res, "Configuration file was not persisted to disk", 500);
      return true;
    }

    const resolvedRuntime =
      normalizeDeploymentTargetConfig(config.deploymentTarget)?.runtime ??
      "local";
    logger.info(
      `[eliza-api] Onboarding complete for agent "${body.name}" (runtime: ${resolvedRuntime})`,
    );
    json(res, { ok: true });
    return true;
  }

  return false;
}
