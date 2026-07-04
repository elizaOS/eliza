/**
 * First-run and provider-switch configuration mutators for `ElizaConfig`.
 * Translates a chosen connection (Eliza Cloud managed, remote provider, local
 * provider, or subscription) into config slots, `env.vars`, and `process.env`
 * so the runtime routes inference at the selected backend. Also owns the full
 * first-run reset — wiping onboarding-derived config, provider env vars, and
 * stored provider credentials — and the third-party `OPENAI_BASE_URL` guard that
 * keeps openai.com default model ids off non-openai upstreams. Mutations are
 * applied in place; consumed by the first-run / config API routes.
 */
import {
  applySubscriptionCredentials,
  deleteProviderCredentials,
} from "@elizaos/auth/credentials";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  SUBSCRIPTION_PROVIDER_MAP,
} from "@elizaos/auth/types";
import type {
  DeploymentTargetConfig,
  LinkedAccountFlagsConfig,
  ServiceCapability,
  ServiceRoutingConfig,
} from "@elizaos/shared";
import {
  asNonEmptyString,
  asRecord,
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  DEFAULT_CEREBRAS_TEXT_MODEL,
  deriveFirstRunCredentialPersistencePlan,
  type FirstRunConnection,
  type FirstRunCredentialInputs,
  type FirstRunLlmPersistenceSelection,
  type FirstRunLocalProviderId,
  getFirstRunProviderOption,
  getFirstRunProviderSignalEnvKeys,
  getStoredFirstRunProviderId,
  getStoredSubscriptionProvider,
  migrateLegacyRuntimeConfig,
  normalizeDeploymentTargetConfig,
  normalizeFirstRunCredentialInputs,
  normalizeFirstRunProviderId,
  normalizeServiceRoutingConfig,
  normalizeSubscriptionProviderSelectionId,
  requiresAdditionalRuntimeProvider,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/types.eliza.ts";

type MutableElizaConfig = Partial<ElizaConfig> & {
  cloud?: Record<string, unknown>;
  models?: Record<string, unknown>;
  wallet?: { rpcProviders?: Record<string, string> };
  deploymentTarget?: DeploymentTargetConfig;
  linkedAccounts?: LinkedAccountFlagsConfig;
  serviceRouting?: ServiceRoutingConfig;
};

const trimToUndefined = asNonEmptyString;

function ensureEnv(config: MutableElizaConfig): Record<string, unknown> {
  config.env ??= {};
  return config.env as Record<string, unknown>;
}

function ensureEnvVars(config: MutableElizaConfig): Record<string, string> {
  const env = ensureEnv(config);
  const existing = asRecord(env.vars);
  if (existing) {
    return existing as Record<string, string>;
  }
  const next: Record<string, string> = {};
  env.vars = next;
  return next;
}

function ensureDefaults(
  config: MutableElizaConfig,
): NonNullable<NonNullable<ElizaConfig["agents"]>["defaults"]> {
  config.agents ??= {};
  config.agents.defaults ??= {};
  return config.agents.defaults;
}

function ensureCloud(config: MutableElizaConfig): Record<string, unknown> {
  config.cloud ??= {};
  return config.cloud;
}

function ensureModels(config: MutableElizaConfig): Record<string, unknown> {
  config.models ??= {};
  return config.models;
}

function ensureLinkedAccounts(
  config: MutableElizaConfig,
): LinkedAccountFlagsConfig {
  config.linkedAccounts ??= {};
  return config.linkedAccounts;
}

function ensureServiceRouting(
  config: MutableElizaConfig,
): ServiceRoutingConfig {
  config.serviceRouting ??= {};
  return config.serviceRouting;
}

function persistDeploymentTarget(
  config: MutableElizaConfig,
  deploymentTarget: DeploymentTargetConfig | null | undefined,
): void {
  if (!deploymentTarget) {
    delete config.deploymentTarget;
    return;
  }
  config.deploymentTarget = { ...deploymentTarget };
}

function persistLinkedAccounts(
  config: MutableElizaConfig,
  linkedAccounts: LinkedAccountFlagsConfig | null | undefined,
): void {
  if (!linkedAccounts) {
    return;
  }

  const existing = ensureLinkedAccounts(config);
  for (const [accountId, account] of Object.entries(linkedAccounts)) {
    if (!account || Object.keys(account).length === 0) {
      delete existing[accountId];
      continue;
    }

    const nextAccount = account as NonNullable<typeof account>;
    existing[accountId] = {
      ...existing[accountId],
      ...nextAccount,
    };
  }

  if (Object.keys(existing).length === 0) {
    delete config.linkedAccounts;
  }
}

function persistServiceRouting(
  config: MutableElizaConfig,
  serviceRouting: ServiceRoutingConfig | null | undefined,
  clearRoutes: readonly ServiceCapability[] = [],
): void {
  const existing = ensureServiceRouting(config);

  for (const capability of clearRoutes) {
    delete existing[capability];
  }

  if (serviceRouting) {
    for (const [capability, route] of Object.entries(serviceRouting)) {
      const serviceKey = capability as ServiceCapability;
      if (!route || Object.keys(route).length === 0) {
        delete existing[serviceKey];
        continue;
      }

      const nextRoute = route as NonNullable<typeof route>;
      existing[serviceKey] = { ...nextRoute };
    }
  }

  if (Object.keys(existing).length === 0) {
    delete config.serviceRouting;
  }
}

export function applyCanonicalFirstRunConfig(
  config: MutableElizaConfig,
  args: {
    deploymentTarget?: DeploymentTargetConfig | null;
    linkedAccounts?: LinkedAccountFlagsConfig | null;
    serviceRouting?: ServiceRoutingConfig | null;
    clearRoutes?: readonly ServiceCapability[];
  },
): void {
  if (args.deploymentTarget !== undefined) {
    persistDeploymentTarget(config, args.deploymentTarget);
  }
  if (args.linkedAccounts !== undefined) {
    persistLinkedAccounts(config, args.linkedAccounts);
  }
  if (args.serviceRouting !== undefined || args.clearRoutes?.length) {
    persistServiceRouting(config, args.serviceRouting, args.clearRoutes);
  }
}

function pruneEnv(config: MutableElizaConfig): void {
  const env = asRecord(config.env);
  if (!env) {
    return;
  }
  const vars = asRecord(env.vars);
  if (vars && Object.keys(vars).length === 0) {
    delete env.vars;
  }

  const envKeys = Object.keys(env).filter((key) => key !== "shellEnv");
  const hasShellEnv = Boolean(env.shellEnv);
  if (envKeys.length === 0 && !hasShellEnv) {
    delete config.env;
  }
}

function setEnvValue(
  config: MutableElizaConfig,
  key: string,
  value: string | undefined,
): void {
  const env = ensureEnv(config);
  const vars = ensureEnvVars(config);
  if (value) {
    env[key] = value;
    vars[key] = value;
    process.env[key] = value;
    return;
  }
  delete env[key];
  delete vars[key];
  delete process.env[key];
  pruneEnv(config);
}

function setPrimaryModel(
  config: MutableElizaConfig,
  primaryModel: string | undefined,
): void {
  const defaults = ensureDefaults(config);
  if (!primaryModel) {
    if (defaults.model) {
      delete defaults.model.primary;
    }
    return;
  }
  defaults.model = { ...defaults.model, primary: primaryModel };
}

function clearPersistedEnvValue(config: MutableElizaConfig, key: string): void {
  const env = asRecord(config.env);
  const vars = asRecord(env?.vars);

  if (vars) {
    delete vars[key];
    if (Object.keys(vars).length === 0 && env) {
      delete env.vars;
    }
  }

  if (env) {
    delete env[key];
    if (Object.keys(env).length === 0) {
      delete config.env;
    }
  }
}

function clearCloudModelSelections(config: MutableElizaConfig): void {
  const models = asRecord(config.models);
  if (!models) {
    return;
  }
  delete models.nano;
  delete models.small;
  delete models.medium;
  delete models.large;
  delete models.mega;
  if (Object.keys(models).length === 0) {
    delete config.models;
  }
}

function clearRemoteProviderConfig(config: MutableElizaConfig): void {
  const cloud = asRecord(config.cloud);
  if (!cloud) {
    return;
  }
  delete cloud.remoteApiBase;
  delete cloud.remoteAccessToken;
  if (cloud.provider === "remote") {
    delete cloud.provider;
  }
}

// Remove ElizaCloud CLI proxy endpoints from process.env and the API keys that server.ts
// pairs with them (same cloud key for both SDKs). Only clears a key when its matching
// base URL pointed at ElizaCloud—so local-provider switches that never set those URLs
// keep multi-key preservation (provider-switch.e2e).
function clearElizaCloudCliProxyEnv(): void {
  const pairs = [
    ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY"],
  ] as const;
  for (const [baseKey, apiKey] of pairs) {
    const v = process.env[baseKey];
    if (v && /elizacloud/i.test(v)) {
      delete process.env[baseKey];
      delete process.env[apiKey];
    }
  }
}

function persistLinkedCloudApiKey(
  config: MutableElizaConfig,
  apiKey: string | undefined,
): void {
  const normalizedApiKey = trimToUndefined(apiKey);
  if (!normalizedApiKey) {
    return;
  }

  const cloud = ensureCloud(config);
  cloud.apiKey = normalizedApiKey;
  process.env.ELIZAOS_CLOUD_API_KEY = normalizedApiKey;

  applyCanonicalFirstRunConfig(config, {
    linkedAccounts: {
      elizacloud: {
        status: "linked",
        source: "api-key",
      },
    },
  });
}

function applyLocalProviderCapabilities(
  config: MutableElizaConfig,
  selection: {
    backend: FirstRunLocalProviderId;
    apiKey?: string;
    primaryModel?: string;
  },
): Promise<void> {
  const normalizedProvider = normalizeFirstRunProviderId(selection.backend);
  if (!normalizedProvider || normalizedProvider === "elizacloud") {
    return Promise.resolve();
  }

  clearElizaCloudCliProxyEnv();
  clearRemoteProviderConfig(config);
  clearCloudModelSelections(config);

  clearSubscriptionProviderConfig(config);

  const storedProviderId = getStoredFirstRunProviderId(normalizedProvider);
  if (
    storedProviderId &&
    normalizeSubscriptionProviderSelectionId(storedProviderId)
  ) {
    applySubscriptionProviderConfig(config, storedProviderId);

    // Subscription coding plans must remain on their first-party coding
    // surfaces. Do not inject their credentials into direct API env vars.
    if (storedProviderId === "anthropic-subscription") {
      // Store the setup token in config for task-agent discovery but do
      // NOT set it in process.env.
      const setupToken = trimToUndefined(selection.apiKey);
      if (setupToken?.startsWith("sk-ant-")) {
        const env = ensureEnv(config);
        // Persist only for config-level discovery, not runtime env.
        (env as Record<string, unknown>).__anthropicSubscriptionToken =
          setupToken;
      }
      return Promise.resolve();
    }

    return applySubscriptionCredentials(config);
  }

  const providerOption = getFirstRunProviderOption(normalizedProvider);
  if (providerOption?.envKey) {
    const apiKey = trimToUndefined(selection.apiKey);
    if (apiKey) {
      setEnvValue(config, providerOption.envKey, apiKey);
    }
  } else {
    for (const envKey of getFirstRunProviderSignalEnvKeys(normalizedProvider)) {
      const value = trimToUndefined(selection.apiKey);
      if (value) {
        setEnvValue(config, envKey, value);
      }
    }
  }

  // Set the primary model plugin so the runtime boosts its priority.
  // If the user didn't pick a specific model, resolve from the provider's
  // plugin name so the correct provider wins the TEXT_SMALL/TEXT_LARGE
  // handler registration.
  const explicitPrimary = trimToUndefined(selection.primaryModel);
  const resolvedPrimary =
    explicitPrimary ?? providerOption?.pluginName ?? undefined;
  setPrimaryModel(config, resolvedPrimary);

  // Set provider-specific default model names so TEXT_SMALL and TEXT_LARGE
  // resolve to sensible models even when the user didn't override them.
  applyDefaultModelNames(config, normalizedProvider);

  return Promise.resolve();
}

/** Default small/large model names by provider family. */
const PROVIDER_DEFAULT_MODELS: Record<
  string,
  { smallKey: string; smallVal: string; largeKey: string; largeVal: string }
> = {
  anthropic: {
    smallKey: "ANTHROPIC_SMALL_MODEL",
    smallVal: "claude-haiku-4-5-20251001",
    largeKey: "ANTHROPIC_LARGE_MODEL",
    largeVal: "claude-opus-4-7",
  },
  openai: {
    smallKey: "OPENAI_SMALL_MODEL",
    smallVal: "gpt-5-mini",
    largeKey: "OPENAI_LARGE_MODEL",
    largeVal: "gpt-5.5",
  },
  google: {
    smallKey: "GOOGLE_SMALL_MODEL",
    smallVal: "gemini-2.0-flash-001",
    largeKey: "GOOGLE_LARGE_MODEL",
    largeVal: "gemini-2.5-pro-preview-03-25",
  },
  groq: {
    smallKey: "GROQ_SMALL_MODEL",
    smallVal: "openai/gpt-oss-120b",
    largeKey: "GROQ_LARGE_MODEL",
    largeVal: "openai/gpt-oss-120b",
  },
  // Cerebras runs through the OpenAI plugin's Cerebras mode, which reads a
  // single `CEREBRAS_MODEL` knob for every model role. Both default text tiers
  // intentionally collapse to Gemma, so one default value covers small, large,
  // mega, and planner while still letting an explicit CEREBRAS_MODEL win.
  cerebras: {
    smallKey: "CEREBRAS_MODEL",
    smallVal: DEFAULT_CEREBRAS_TEXT_MODEL,
    largeKey: "CEREBRAS_MODEL",
    largeVal: DEFAULT_CEREBRAS_TEXT_MODEL,
  },
  nearai: {
    smallKey: "NEARAI_SMALL_MODEL",
    smallVal: "google/gemma-4-31B-it",
    largeKey: "NEARAI_LARGE_MODEL",
    largeVal: "google/gemma-4-31B-it",
  },
};

/**
 * @internal Exported for testing only.
 *
 * True when the active `OPENAI_BASE_URL` points at a non-openai.com host
 * (Cerebras, Groq, OpenRouter, Together, vLLM, LM Studio, an in-house
 * gateway, etc.). The "openai" provider id then represents an OpenAI-API
 * shape served by a *different* upstream — `gpt-5.5` and `gpt-5-mini`
 * are not portable to those upstreams, so stamping them as the default
 * model ids actively breaks the runtime.
 *
 * Returns false when:
 *  - `OPENAI_BASE_URL` is unset (the caller is using openai.com directly,
 *    so the default model ids are correct), OR
 *  - the base URL parses to an `api.openai.com` host (still openai.com).
 *
 * Returns true when the URL is set to any other host — including
 * subdomains of openai.com that aren't `api.openai.com`. We err on the
 * conservative side here: an operator pointing at a custom OpenAI
 * endpoint can pass explicit model ids; the failure mode of NOT stamping
 * is "user has to type their model name", which is strictly better than
 * stamping a model the upstream rejects with 404.
 */
export function openAiBaseUrlIsThirdParty(): boolean {
  const raw = process.env.OPENAI_BASE_URL?.trim();
  if (!raw) return false;
  try {
    const hostname = new URL(raw).hostname.trim().toLowerCase();
    if (!hostname) return false;
    return hostname !== "api.openai.com";
  } catch {
    // Unparseable URL: assume third-party. Stamping defaults under a
    // broken base URL is never the right move.
    return true;
  }
}

function applyDefaultModelNames(
  config: MutableElizaConfig,
  provider: string,
): void {
  const defaults = PROVIDER_DEFAULT_MODELS[provider];
  if (!defaults) return;

  // Guard: when the active `OPENAI_BASE_URL` points at a non-openai.com
  // upstream (Cerebras, Groq, OpenRouter, vLLM, an in-house gateway, …),
  // skip stamping the `OPENAI_*_MODEL` defaults — those gpt-5.5 /
  // gpt-5-mini ids are openai.com inventory and will 404 on every other
  // upstream. The caller can still pin specific models via the
  // `primaryModel` field on the connection object; that path is unaffected.
  //
  // We only guard the `openai` provider id because (a) it's the only
  // provider with this base-URL-override pattern in practice and (b) the
  // `anthropic` / `google` / `groq` / `mlx` provider ids each point at
  // their own SDK + endpoint, with no equivalent "base URL swap" footgun.
  if (provider === "openai" && openAiBaseUrlIsThirdParty()) {
    return;
  }

  // Only set if not already configured — don't clobber user overrides.
  if (!process.env[defaults.smallKey]) {
    setEnvValue(config, defaults.smallKey, defaults.smallVal);
  }
  if (!process.env[defaults.largeKey]) {
    setEnvValue(config, defaults.largeKey, defaults.largeVal);
  }
}

function toFirstRunConnectionFromSelection(
  selection: FirstRunLlmPersistenceSelection,
): FirstRunConnection | null {
  if (selection.transport === "cloud-proxy") {
    return {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
      ...(trimToUndefined(selection.apiKey)
        ? { apiKey: trimToUndefined(selection.apiKey) }
        : {}),
      ...(trimToUndefined(selection.nanoModel)
        ? { nanoModel: trimToUndefined(selection.nanoModel) }
        : {}),
      ...(trimToUndefined(selection.smallModel)
        ? { smallModel: trimToUndefined(selection.smallModel) }
        : {}),
      ...(trimToUndefined(selection.mediumModel)
        ? { mediumModel: trimToUndefined(selection.mediumModel) }
        : {}),
      ...(trimToUndefined(selection.largeModel)
        ? { largeModel: trimToUndefined(selection.largeModel) }
        : {}),
      ...(trimToUndefined(selection.megaModel)
        ? { megaModel: trimToUndefined(selection.megaModel) }
        : {}),
      ...(trimToUndefined(selection.responseHandlerModel)
        ? {
            responseHandlerModel: trimToUndefined(
              selection.responseHandlerModel,
            ),
          }
        : {}),
      ...(trimToUndefined(selection.shouldRespondModel)
        ? { shouldRespondModel: trimToUndefined(selection.shouldRespondModel) }
        : {}),
      ...(trimToUndefined(selection.actionPlannerModel)
        ? { actionPlannerModel: trimToUndefined(selection.actionPlannerModel) }
        : {}),
      ...(trimToUndefined(selection.plannerModel)
        ? { plannerModel: trimToUndefined(selection.plannerModel) }
        : {}),
      ...(trimToUndefined(selection.responseModel)
        ? { responseModel: trimToUndefined(selection.responseModel) }
        : {}),
      ...(trimToUndefined(selection.mediaDescriptionModel)
        ? {
            mediaDescriptionModel: trimToUndefined(
              selection.mediaDescriptionModel,
            ),
          }
        : {}),
    };
  }

  const normalizedProvider = normalizeFirstRunProviderId(selection.backend);
  if (!normalizedProvider || normalizedProvider === "elizacloud") {
    return null;
  }

  if (selection.transport === "remote") {
    const remoteApiBase = trimToUndefined(selection.remoteApiBase);
    if (!remoteApiBase) {
      return null;
    }

    return {
      kind: "remote-provider",
      remoteApiBase,
      provider: normalizedProvider,
      ...(trimToUndefined(selection.remoteAccessToken)
        ? { remoteAccessToken: trimToUndefined(selection.remoteAccessToken) }
        : {}),
      ...(trimToUndefined(selection.apiKey)
        ? { apiKey: trimToUndefined(selection.apiKey) }
        : {}),
      ...(trimToUndefined(selection.primaryModel)
        ? { primaryModel: trimToUndefined(selection.primaryModel) }
        : {}),
    };
  }

  return {
    kind: "local-provider",
    provider: normalizedProvider as FirstRunLocalProviderId,
    ...(trimToUndefined(selection.apiKey)
      ? { apiKey: trimToUndefined(selection.apiKey) }
      : {}),
    ...(trimToUndefined(selection.primaryModel)
      ? { primaryModel: trimToUndefined(selection.primaryModel) }
      : {}),
  };
}

/**
 * Apply subscription provider configuration to the config object.
 *
 * Sets `agents.defaults.subscriptionProvider` so the task-agent orchestrator
 * knows which subscription is active.
 *
 * For providers with a runtime model-provider plugin, also sets
 * `agents.defaults.model.primary`. Anthropic subscriptions are restricted to
 * Claude Code CLI (TOS), so `model.primary` is NOT set for that provider.
 *
 * Mutates `config` in place.
 */
export function applySubscriptionProviderConfig(
  config: Partial<ElizaConfig>,
  provider: string,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  const defaults = config.agents.defaults;

  const selectionId = normalizeSubscriptionProviderSelectionId(provider);
  const subscriptionKey = selectionId
    ? getStoredSubscriptionProvider(selectionId)
    : provider;
  const modelProvider =
    SUBSCRIPTION_PROVIDER_MAP[
      subscriptionKey as keyof typeof SUBSCRIPTION_PROVIDER_MAP
    ];

  if (modelProvider) {
    defaults.subscriptionProvider = subscriptionKey;

    // Only set model.primary for providers with a runtime model-provider
    // plugin. Anthropic subscription tokens are restricted to Claude Code
    // CLI (TOS), so the runtime cannot use them for LLM inference.
    const runtimeApplicable = subscriptionKey === "openai-codex";
    if (runtimeApplicable) {
      defaults.model = { ...defaults.model, primary: modelProvider };
    }
  }
}

/**
 * Clear subscription provider configuration from the config object.
 *
 * Removes `agents.defaults.subscriptionProvider` so the runtime
 * doesn't try to auto-detect a subscription provider on restart.
 *
 * Mutates `config` in place.
 */
export function clearSubscriptionProviderConfig(
  config: Partial<ElizaConfig>,
): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  delete config.agents.defaults.subscriptionProvider;
}

/**
 * Clear persisted first-run state that should force the UI back through the
 * first-run setup on the next load/reset.
 */
export function clearPersistedFirstRunConfig(config: MutableElizaConfig): void {
  if (config.meta && typeof config.meta === "object") {
    delete (config.meta as Record<string, unknown>).firstRunComplete;
  }

  config.agents = { list: [] };

  if (config.cloud && typeof config.cloud === "object") {
    config.cloud = {};
  }

  const models = asRecord(config.models);
  if (models) {
    delete models.nano;
    delete models.small;
    delete models.medium;
    delete models.large;
    delete models.mega;
    if (Object.keys(models).length === 0) {
      delete config.models;
    }
  }

  // Clear voice settings so presets apply their correct voice on first-run setup.
  const messages = asRecord(config.messages);
  if (messages) {
    delete messages.tts;
    if (Object.keys(messages).length === 0) {
      delete config.messages;
    }
  }

  // Clear UI state (avatar, preset selection) so the full character resets.
  // Without this, the avatar survives a reset but the voice doesn't,
  // causing mismatched character state (e.g. male preset with female voice).
  delete config.ui;

  delete (config as Record<string, unknown>).connection;
  delete config.deploymentTarget;
  delete config.linkedAccounts;
  delete config.serviceRouting;

  const signalProviders = [
    "anthropic",
    "anthropic-subscription",
    "cerebras",
    "deepseek",
    "gemini",
    "grok",
    "groq",
    "mistral",
    "moonshot",
    "nearai",
    "ollama",
    "openai",
    "openai-subscription",
    "openrouter",
    "together",
    "zai",
  ] as const satisfies readonly FirstRunLocalProviderId[];

  for (const providerId of signalProviders) {
    for (const envKey of getFirstRunProviderSignalEnvKeys(providerId)) {
      clearPersistedEnvValue(config, envKey);
      delete process.env[envKey];
    }
  }

  // A full reset must also drop the provider-specific default model env vars
  // that applyDefaultModelNames stamps (ANTHROPIC_LARGE_MODEL, OPENAI_SMALL_MODEL,
  // CEREBRAS_MODEL, …); otherwise a stale model id from a prior provider survives
  // into the next fresh first-run.
  for (const { smallKey, largeKey } of Object.values(PROVIDER_DEFAULT_MODELS)) {
    for (const envKey of new Set([smallKey, largeKey])) {
      clearPersistedEnvValue(config, envKey);
      delete process.env[envKey];
    }
  }

  delete process.env.ELIZAOS_CLOUD_API_KEY;
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
  for (const provider of SUBSCRIPTION_PROVIDER_IDS) {
    deleteProviderCredentials(provider);
  }
}

export function createProviderSwitchConnection(args: {
  provider: string;
  apiKey?: string;
  primaryModel?: string;
}): FirstRunConnection | null {
  const provider = normalizeFirstRunProviderId(args.provider);
  if (!provider) {
    return null;
  }

  if (provider === "elizacloud") {
    return {
      kind: "cloud-managed",
      cloudProvider: "elizacloud",
    };
  }

  return {
    kind: "local-provider",
    provider,
    apiKey: trimToUndefined(args.apiKey),
    primaryModel: trimToUndefined(args.primaryModel),
  };
}

export async function applyFirstRunConnectionConfig(
  config: MutableElizaConfig,
  connection: FirstRunConnection,
): Promise<void> {
  const normalizedConnection = connection;

  delete (config as Record<string, unknown>).connection;
  const existingDeploymentTarget = normalizeDeploymentTargetConfig(
    config.deploymentTarget,
  );
  // Embeddings follow the runtime: a cloud agent uses cloud embeddings, a
  // local agent (including local+cloud-inference hybrid) keeps embeddings
  // local so vectors never depend on a network round-trip.
  const excludeServices =
    existingDeploymentTarget?.runtime === "cloud"
      ? undefined
      : (["embeddings"] as const);

  if (normalizedConnection.kind === "cloud-managed") {
    clearRemoteProviderConfig(config);
    clearCloudModelSelections(config);
    setPrimaryModel(config, undefined);

    const cloud = ensureCloud(config);
    const models = ensureModels(config);
    const apiKey = trimToUndefined(normalizedConnection.apiKey);
    if (apiKey) {
      cloud.apiKey = apiKey;
      process.env.ELIZAOS_CLOUD_API_KEY = apiKey;
    }
    if (normalizedConnection.nanoModel) {
      models.nano = normalizedConnection.nanoModel;
    }
    if (normalizedConnection.smallModel) {
      models.small = normalizedConnection.smallModel;
    }
    if (normalizedConnection.mediumModel) {
      models.medium = normalizedConnection.mediumModel;
    }
    if (normalizedConnection.largeModel) {
      models.large = normalizedConnection.largeModel;
    }
    if (normalizedConnection.megaModel) {
      models.mega = normalizedConnection.megaModel;
    }

    const serviceRouting = buildDefaultElizaCloudServiceRouting({
      base: {
        ...config.serviceRouting,
        llmText: buildElizaCloudServiceRoute({
          nanoModel: normalizedConnection.nanoModel,
          smallModel: normalizedConnection.smallModel,
          mediumModel: normalizedConnection.mediumModel,
          largeModel: normalizedConnection.largeModel,
          megaModel: normalizedConnection.megaModel,
          responseHandlerModel: normalizedConnection.responseHandlerModel,
          shouldRespondModel: normalizedConnection.shouldRespondModel,
          actionPlannerModel: normalizedConnection.actionPlannerModel,
          plannerModel: normalizedConnection.plannerModel,
          responseModel: normalizedConnection.responseModel,
          mediaDescriptionModel: normalizedConnection.mediaDescriptionModel,
        }),
      },
      ...(excludeServices ? { excludeServices } : {}),
    });

    applyCanonicalFirstRunConfig(config, {
      deploymentTarget: existingDeploymentTarget,
      linkedAccounts: apiKey
        ? {
            elizacloud: {
              status: "linked",
              source: "api-key",
            },
          }
        : undefined,
      serviceRouting,
    });

    process.env.ELIZAOS_CLOUD_ENABLED = "true";
    clearSubscriptionProviderConfig(config);
    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    return;
  }

  delete process.env.ELIZAOS_CLOUD_ENABLED;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
  delete process.env.ELIZAOS_CLOUD_NANO_MODEL;
  delete process.env.ELIZAOS_CLOUD_MEDIUM_MODEL;
  delete process.env.ELIZAOS_CLOUD_SMALL_MODEL;
  delete process.env.ELIZAOS_CLOUD_LARGE_MODEL;
  delete process.env.ELIZAOS_CLOUD_MEGA_MODEL;
  delete process.env.ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL;
  delete process.env.ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL;
  delete process.env.ELIZAOS_CLOUD_ACTION_PLANNER_MODEL;
  delete process.env.ELIZAOS_CLOUD_PLANNER_MODEL;

  if (normalizedConnection.kind === "remote-provider") {
    clearSubscriptionProviderConfig(config);
    clearCloudModelSelections(config);
    clearRemoteProviderConfig(config);
    setPrimaryModel(config, undefined);

    applyCanonicalFirstRunConfig(config, {
      deploymentTarget: {
        runtime: "remote",
        provider: "remote",
        remoteApiBase: normalizedConnection.remoteApiBase,
        ...(normalizedConnection.remoteAccessToken
          ? { remoteAccessToken: normalizedConnection.remoteAccessToken }
          : {}),
      },
      serviceRouting: normalizedConnection.provider
        ? {
            llmText: {
              backend: normalizedConnection.provider,
              transport: "remote",
              remoteApiBase: normalizedConnection.remoteApiBase,
              ...(normalizedConnection.primaryModel
                ? { primaryModel: normalizedConnection.primaryModel }
                : {}),
            },
          }
        : undefined,
      clearRoutes: normalizedConnection.provider ? [] : ["llmText"],
    });

    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    return;
  }

  await applyLocalProviderCapabilities(config, {
    backend: normalizedConnection.provider,
    ...(normalizedConnection.apiKey
      ? { apiKey: normalizedConnection.apiKey }
      : {}),
    ...(normalizedConnection.primaryModel
      ? { primaryModel: normalizedConnection.primaryModel }
      : {}),
  });
  const linkedAccounts: LinkedAccountFlagsConfig | undefined =
    normalizedConnection.provider === "anthropic-subscription" ||
    normalizedConnection.provider === "openai-subscription"
      ? {
          [normalizedConnection.provider]: {
            status: "linked",
            source: "subscription",
          },
        }
      : undefined;
  const shouldDefaultCloudServices =
    existingDeploymentTarget?.runtime === "cloud" &&
    existingDeploymentTarget.provider === "elizacloud";
  const directLlmRoute = {
    backend: normalizedConnection.provider,
    transport: "direct",
    ...(normalizedConnection.primaryModel
      ? { primaryModel: normalizedConnection.primaryModel }
      : {}),
  } satisfies NonNullable<ServiceRoutingConfig["llmText"]>;
  const serviceRouting = shouldDefaultCloudServices
    ? buildDefaultElizaCloudServiceRouting({
        base: {
          ...config.serviceRouting,
          llmText: directLlmRoute,
        },
        ...(excludeServices ? { excludeServices } : {}),
      })
    : {
        llmText: directLlmRoute,
      };

  if (requiresAdditionalRuntimeProvider(normalizedConnection.provider)) {
    const currentBackend = normalizeFirstRunProviderId(
      normalizeServiceRoutingConfig(config.serviceRouting)?.llmText?.backend,
    );
    applyCanonicalFirstRunConfig(config, {
      deploymentTarget: existingDeploymentTarget,
      linkedAccounts,
      clearRoutes:
        currentBackend === normalizedConnection.provider ? ["llmText"] : [],
    });
    migrateLegacyRuntimeConfig(config as Record<string, unknown>);
    return;
  }

  applyCanonicalFirstRunConfig(config, {
    deploymentTarget: existingDeploymentTarget,
    linkedAccounts,
    serviceRouting,
  });
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
}

export async function applyFirstRunCredentialPersistence(
  config: MutableElizaConfig,
  args: {
    credentialInputs?: FirstRunCredentialInputs | null;
    deploymentTarget?: DeploymentTargetConfig | null;
    serviceRouting?: ServiceRoutingConfig | null;
  },
): Promise<string | null> {
  const plan = deriveFirstRunCredentialPersistencePlan({
    credentialInputs: normalizeFirstRunCredentialInputs(args.credentialInputs),
    deploymentTarget: args.deploymentTarget,
    serviceRouting: args.serviceRouting,
  });

  if (plan.llmSelection) {
    const llmConnection = toFirstRunConnectionFromSelection(plan.llmSelection);
    if (llmConnection) {
      await applyFirstRunConnectionConfig(config, llmConnection);
    }
  }

  if (plan.cloudApiKey) {
    persistLinkedCloudApiKey(config, plan.cloudApiKey);
  }

  migrateLegacyRuntimeConfig(config as Record<string, unknown>);

  if (plan.llmSelection?.transport !== "direct") {
    return null;
  }

  const provider = normalizeFirstRunProviderId(plan.llmSelection.backend);
  if (!provider || provider === "elizacloud") {
    return null;
  }

  return getFirstRunProviderOption(provider)?.envKey ?? null;
}
