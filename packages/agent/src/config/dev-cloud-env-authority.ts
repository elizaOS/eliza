/**
 * Internal contract stamped by the app development launchers. Persisted
 * account/config state must not replace the Cloud environment selected for a
 * local development process.
 */

import {
  captureDevCloudEnvAuthoritySnapshot,
  DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
  type DevCloudEnvAuthority,
  resetDevCloudEnvAuthorityForTests as resetSharedDevCloudEnvAuthorityForTests,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority as resolveSharedDevCloudEnvAuthority,
} from "@elizaos/shared";

export const DEV_CLOUD_ENV_AUTHORITY_KEY =
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY" as const;

export type { DevCloudEnvAuthority };

/**
 * Persisted environment fields whose launch-time values outrank config/vault
 * state. Keep this Cloud-specific: generic model aliases such as SMALL_MODEL
 * still belong to direct/local providers when the dev target is offline.
 */
export const DEV_CLOUD_ENV_OWNED_KEYS = [
  ...DEV_CLOUD_STEWARD_OPERATIONAL_ENV_KEYS,
  "ELIZA_DEV_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_SERVICE_KEY",
  "ELIZA_CLOUD_API_KEY",
  "ELIZA_CLOUD_SERVICE_KEY",
  "ELIZA_CLOUD_SERVICE_TOKEN",
  "ELIZA_CLOUD_SESSION_TOKEN",
  "ELIZA_CLOUD_TOKEN",
  "ELIZACLOUD_API_KEY",
  "ELIZACLOUD_TOKEN",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_API_BASE_URL",
  "ELIZAOS_CLOUD_REQUEST_BASE_URL",
  "ELIZAOS_CLOUD_URL",
  "ELIZAOS_CLOUD_BROWSER_BASE_URL",
  "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL",
  "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
  "ELIZAOS_CLOUD_EMBEDDING_URL",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZAOS_CLOUD_AGENT_ID",
  "ELIZA_CLOUD_AGENT_ID",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
  "ELIZA_CLOUD_API_BASE_URL",
  "ELIZA_CLOUD_API_BASE",
  "ELIZA_CLOUD_API_URL",
  "ELIZA_CLOUD_BASE",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZA_CLOUD_LOCAL_API_URL",
  "ELIZA_CLOUD_LOCAL_APP_URL",
  "ELIZA_CLOUD_OPENAI_BASE_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ELIZA_CLOUD_ROUTE_BASE",
  "ELIZA_CLOUD_URL",
  "ELIZA_CLOUD_WEB_URL",
  "ELIZA_CLOUD_WRITE_BASE_URL",
  "ELIZACLOUD_API_BASE_URL",
  "ELIZACLOUD_API_URL",
  "ELIZACLOUD_DEFAULT_URL",
  "ELIZA_CLOUD_SANDBOX_API_BASE_URL",
  "ELIZA_CLOUD_SANDBOX_BASE_URL",
  "ELIZA_CLOUD_SANDBOX_ACCESS_URL",
  "ELIZA_CLOUD_REMOTE_RUNNER_URL",
  "ELIZA_CLOUD_RUNNER_URL",
  "ELIZA_CLOUD_AUTH_TOKEN",
  "ELIZA_CLOUD_SANDBOX_TOKEN",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_STT",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_RPC",
  "ELIZAOS_CLOUD_NANO_MODEL",
  "ELIZAOS_CLOUD_SMALL_MODEL",
  "ELIZAOS_CLOUD_MEDIUM_MODEL",
  "ELIZAOS_CLOUD_LARGE_MODEL",
  "ELIZAOS_CLOUD_MEGA_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL",
  "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL",
  "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL",
  "ELIZAOS_CLOUD_PLANNER_MODEL",
  "ELIZAOS_CLOUD_RESPONSE_MODEL",
  "ELIZAOS_CLOUD_MEDIA_DESCRIPTION_MODEL",
] as const;

/**
 * applyCloudConfigToEnv also writes compatibility model aliases and derived
 * disabled flags. Snapshot them so the authority wrapper can restore the exact
 * launcher process environment without treating them as Cloud-owned config.
 */
export const DEV_CLOUD_ENV_RESTORE_KEYS = [
  ...DEV_CLOUD_ENV_OWNED_KEYS,
  "ELIZA_DEV_SOURCE",
  DEV_CLOUD_ENV_AUTHORITY_KEY,
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZA_CLOUD_TTS_DISABLED",
  "ELIZA_CLOUD_MEDIA_DISABLED",
  "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  "ELIZA_CLOUD_RPC_DISABLED",
  "NANO_MODEL",
  "SMALL_MODEL",
  "MEDIUM_MODEL",
  "LARGE_MODEL",
  "MEGA_MODEL",
] as const;

const DEV_CLOUD_ENV_OWNED_KEY_SET = new Set<string>(DEV_CLOUD_ENV_OWNED_KEYS);

const DEV_CLOUD_INTERNAL_KEYS = new Set<string>([
  "ELIZA_DEV_SOURCE",
  DEV_CLOUD_ENV_AUTHORITY_KEY,
  "ELIZA_DEV_CLOUD_TARGET",
]);

const DEV_CLOUD_CONFIG_AUTHORITY_VIEW = Symbol.for(
  "@elizaos/agent/dev-cloud-config-authority-view",
);

export type DevCloudEnvSnapshot = Readonly<{
  authority: DevCloudEnvAuthority;
  values: Readonly<Record<string, string | undefined>>;
}>;

let frozenProcessEnvSnapshot: DevCloudEnvSnapshot | undefined;

/** Ignore the marker outside a launcher-owned development process. */
export function resolveDevCloudEnvAuthority(
  env: NodeJS.ProcessEnv = process.env,
): DevCloudEnvAuthority | null {
  return resolveSharedDevCloudEnvAuthority(env);
}

export function isDevCloudEnvOwnedKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  if (DEV_CLOUD_INTERNAL_KEYS.has(normalizedKey)) return false;
  return (
    DEV_CLOUD_ENV_OWNED_KEY_SET.has(normalizedKey) ||
    normalizedKey.startsWith("ELIZAOS_CLOUD_") ||
    normalizedKey.startsWith("ELIZA_CLOUD_") ||
    normalizedKey.startsWith("ELIZA_DEV_CLOUD_") ||
    normalizedKey.startsWith("ELIZACLOUD_") ||
    normalizedKey.startsWith("WAIFU_ELIZA_CLOUD_")
  );
}

/** Internal launcher markers must never be fabricated by persisted config. */
export function isDevCloudInternalEnvKey(key: string): boolean {
  return DEV_CLOUD_INTERNAL_KEYS.has(key.toUpperCase());
}

export function captureDevCloudEnvAuthority(
  env: NodeJS.ProcessEnv = process.env,
): DevCloudEnvSnapshot | null {
  const authority = resolveDevCloudEnvAuthority(env);
  if (!authority) return null;
  if (env === process.env && frozenProcessEnvSnapshot) {
    return frozenProcessEnvSnapshot;
  }

  const sharedSnapshot = captureDevCloudEnvAuthoritySnapshot(env);
  if (!sharedSnapshot) return null;

  const keys = new Set<string>([
    ...DEV_CLOUD_ENV_RESTORE_KEYS,
    ...Object.keys(sharedSnapshot.values),
    ...Object.keys(env).filter(isDevCloudEnvOwnedKey),
  ]);
  const values = Object.fromEntries(
    [...keys].map((key) => [
      key,
      isDevCloudEnvOwnedKey(key) || isDevCloudInternalEnvKey(key)
        ? resolveDevCloudAuthorityEnvValue(key, env)
        : env[key],
    ]),
  );
  const snapshot = Object.freeze({
    authority,
    values: Object.freeze(values),
  });
  if (env === process.env) frozenProcessEnvSnapshot = snapshot;
  return snapshot;
}

/** @internal Test isolation for the process-lifetime launch snapshot. */
export function resetDevCloudEnvAuthorityForTests(): void {
  frozenProcessEnvSnapshot = undefined;
  resetSharedDevCloudEnvAuthorityForTests();
}

/** Restore the exact launcher-owned tuple after config/vault projection. */
export function restoreDevCloudEnvAuthority(
  snapshot: DevCloudEnvSnapshot,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const keys = new Set<string>([
    ...DEV_CLOUD_ENV_RESTORE_KEYS,
    ...Object.keys(snapshot.values),
    ...Object.keys(env).filter(isDevCloudEnvOwnedKey),
  ]);
  for (const key of keys) {
    const value = snapshot.values[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next || undefined;
}

function usableCredential(value: string | undefined): string | undefined {
  const next = trimmed(value);
  if (
    !next ||
    next.toUpperCase() === "[REDACTED]" ||
    next.toLowerCase().startsWith("vault://")
  ) {
    return undefined;
  }
  return next;
}

function truthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isElizaCloudRoute(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  const backend =
    typeof route.backend === "string" ? route.backend.trim().toLowerCase() : "";
  return (
    route.transport === "cloud-proxy" &&
    ["elizacloud", "eliza-cloud", "@elizaos/plugin-elizacloud"].includes(
      backend,
    )
  );
}

function hasDirectTextRoute(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }
  const routing = (config as Record<string, unknown>).serviceRouting;
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) {
    return false;
  }
  const route = (routing as Record<string, unknown>).llmText;
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return false;
  }
  const record = route as Record<string, unknown>;
  return (
    record.transport === "direct" &&
    typeof record.backend === "string" &&
    Boolean(trimmed(record.backend))
  );
}

function removeOwnedConfigEnv(config: Record<string, unknown>): void {
  const configEnv = config.env;
  if (!configEnv || typeof configEnv !== "object" || Array.isArray(configEnv)) {
    return;
  }
  const mutableEnv = configEnv as Record<string, unknown>;
  const vars = mutableEnv.vars;
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    const mutableVars = vars as Record<string, unknown>;
    for (const key of Object.keys(mutableVars)) {
      if (isDevCloudEnvOwnedKey(key)) delete mutableVars[key];
    }
    for (const key of DEV_CLOUD_INTERNAL_KEYS) delete mutableVars[key];
    if (Object.keys(mutableVars).length === 0) delete mutableEnv.vars;
  }
  for (const key of Object.keys(mutableEnv)) {
    if (isDevCloudEnvOwnedKey(key)) delete mutableEnv[key];
  }
  for (const key of DEV_CLOUD_INTERNAL_KEYS) delete mutableEnv[key];
}

function removeOwnedRuntimeSettingKeys(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isDevCloudEnvOwnedKey(key) || isDevCloudInternalEnvKey(key)) {
      delete record[key];
      continue;
    }
    if (["secrets", "extra", "vars", "env"].includes(key)) {
      removeOwnedRuntimeSettingKeys(record[key]);
    }
  }
}

function removeOwnedAgentRuntimeSettings(
  config: Record<string, unknown>,
): void {
  const agents = config.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) return;
  const agentsRecord = agents as Record<string, unknown>;
  const sanitizeAgent = (agent: unknown): void => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) return;
    const record = agent as Record<string, unknown>;
    removeOwnedRuntimeSettingKeys(record.settings);
    removeOwnedRuntimeSettingKeys(record.secrets);
    removeOwnedRuntimeSettingKeys(record.env);
  };
  sanitizeAgent(agentsRecord.defaults);
  if (Array.isArray(agentsRecord.list)) {
    for (const agent of agentsRecord.list) sanitizeAgent(agent);
  }
}

/**
 * Remove persisted Cloud ownership from the in-memory config and project only
 * the launcher-selected connection. This never writes the sanitized view back
 * to disk; it protects the current local-development process only.
 */
export function applyDevCloudConfigAuthority(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): DevCloudEnvSnapshot | null {
  const snapshot = captureDevCloudEnvAuthority(env);
  if (!snapshot) return null;
  const activationBlocked =
    snapshot.authority === "staging-default" ||
    snapshot.authority === "offline";
  const forceCloudInference =
    !activationBlocked && truthy(snapshot.values.ELIZAOS_CLOUD_USE_INFERENCE);

  removeOwnedConfigEnv(config);
  removeOwnedAgentRuntimeSettings(config);

  config.deploymentTarget = { runtime: "local" };

  const routing = config.serviceRouting;
  if (routing && typeof routing === "object" && !Array.isArray(routing)) {
    const filteredRouting = Object.fromEntries(
      Object.entries(routing as Record<string, unknown>).filter(
        ([capability, route]) =>
          !isElizaCloudRoute(route) &&
          !(capability === "llmText" && forceCloudInference),
      ),
    );
    if (Object.keys(filteredRouting).length === 0) {
      delete config.serviceRouting;
    } else {
      config.serviceRouting = filteredRouting;
    }
  }

  const linkedAccounts = config.linkedAccounts;
  if (
    linkedAccounts &&
    typeof linkedAccounts === "object" &&
    !Array.isArray(linkedAccounts)
  ) {
    const nextLinkedAccounts = {
      ...(linkedAccounts as Record<string, unknown>),
    };
    delete nextLinkedAccounts.elizacloud;
    if (Object.keys(nextLinkedAccounts).length > 0) {
      config.linkedAccounts = nextLinkedAccounts;
    } else {
      delete config.linkedAccounts;
    }
  }

  const existingCloud =
    config.cloud &&
    typeof config.cloud === "object" &&
    !Array.isArray(config.cloud)
      ? { ...(config.cloud as Record<string, unknown>) }
      : {};
  for (const key of [
    "provider",
    "remoteApiBase",
    "remoteAccessToken",
    "baseUrl",
    "apiKey",
    "serviceKey",
    "agentId",
    "enabled",
    "inferenceMode",
    "services",
    "runtime",
  ]) {
    delete existingCloud[key];
  }

  const apiKey = activationBlocked
    ? undefined
    : (usableCredential(snapshot.values.ELIZAOS_CLOUD_API_KEY) ??
      usableCredential(snapshot.values.ELIZA_DEV_CLOUD_API_KEY) ??
      usableCredential(snapshot.values.ELIZA_CLOUD_API_KEY) ??
      usableCredential(snapshot.values.ELIZACLOUD_API_KEY));
  const baseUrl = trimmed(snapshot.values.ELIZAOS_CLOUD_BASE_URL);
  const agentId =
    trimmed(snapshot.values.ELIZAOS_CLOUD_AGENT_ID) ??
    trimmed(snapshot.values.ELIZA_CLOUD_AGENT_ID) ??
    trimmed(snapshot.values.WAIFU_ELIZA_CLOUD_AGENT_ID);
  const enabled =
    !activationBlocked &&
    (Boolean(apiKey) ||
      snapshot.values.ELIZA_CLOUD_PROVISIONED?.trim() === "1");

  config.cloud = {
    ...existingCloud,
    enabled,
    ...(baseUrl ? { baseUrl } : {}),
    // An explicit blank is a deny-fallback sentinel for helpers that otherwise
    // consult runtime secrets or process.env when config.cloud.apiKey is absent.
    // That closes stale-runtime escapes in status, billing, wallet RPC, and
    // compatibility routes under staging-default/offline authority.
    apiKey: apiKey ?? "",
    ...(agentId ? { agentId } : {}),
  };

  return snapshot;
}

/**
 * Exact per-runtime settings that outrank DB-persisted AgentRuntime values.
 * AgentRuntime's initialization merge deliberately lets constructor settings
 * override DB values without writing those overrides back to the database.
 */
export function createDevCloudRuntimeSettingsAuthorityOverlay(
  env: NodeJS.ProcessEnv = process.env,
  config?: unknown,
): Record<string, string> {
  const snapshot = captureDevCloudEnvAuthority(env);
  if (!snapshot) return {};
  const keys = new Set<string>([
    ...DEV_CLOUD_ENV_OWNED_KEYS,
    ...Object.keys(snapshot.values).filter(isDevCloudEnvOwnedKey),
  ]);
  const overlay = Object.fromEntries(
    [...keys].map((key) => [key, snapshot.values[key] ?? ""]),
  );
  // A launcher credential may keep Cloud loaded for non-text capabilities while
  // a canonical direct route owns the chat brain. An omitted/blank launch flag
  // means "no Cloud inference override", not the plugin's standalone default of
  // registering every priority-50 text handler. Project the route decision into
  // runtime settings; an explicit truthy launcher flag remains authoritative.
  if (
    hasDirectTextRoute(config) &&
    !truthy(snapshot.values.ELIZAOS_CLOUD_USE_INFERENCE)
  ) {
    overlay.ELIZAOS_CLOUD_USE_INFERENCE = "false";
  }
  return overlay;
}

/** Build an ephemeral runtime view without altering the persistable config. */
export function createDevCloudConfigAuthorityView<T extends object>(
  config: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  if (!resolveDevCloudEnvAuthority(env)) return config;
  const view = structuredClone(config);
  applyDevCloudConfigAuthority(view as Record<string, unknown>, env);
  Object.defineProperty(view, DEV_CLOUD_CONFIG_AUTHORITY_VIEW, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return view;
}

export function isDevCloudConfigAuthorityView(value: object): boolean {
  return (
    (value as Record<PropertyKey, unknown>)[DEV_CLOUD_CONFIG_AUTHORITY_VIEW] ===
    true
  );
}

/**
 * Deliberately turn a mutated authority view into a persistable snapshot.
 * Only explicit Cloud mutation routes should call this; ordinary persistence
 * continues to reject marked ephemeral views.
 */
export function materializeDevCloudConfigAuthorityView<T extends object>(
  config: T,
): T {
  return isDevCloudConfigAuthorityView(config)
    ? structuredClone(config)
    : config;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => configValuesEqual(value, right[index]))
    );
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) && configValuesEqual(left[key], right[key]),
    )
  );
}

function applyConfigMutationDelta(
  durable: unknown,
  before: unknown,
  after: unknown,
): unknown {
  if (configValuesEqual(before, after)) return durable;
  if (!isPlainRecord(before) || !isPlainRecord(after)) {
    return structuredClone(after);
  }

  const merged: Record<string, unknown> = isPlainRecord(durable)
    ? structuredClone(durable)
    : {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!Object.hasOwn(after, key)) {
      delete merged[key];
      continue;
    }
    if (!Object.hasOwn(before, key)) {
      merged[key] = structuredClone(after[key]);
      continue;
    }
    merged[key] = applyConfigMutationDelta(
      merged[key],
      before[key],
      after[key],
    );
  }
  return merged;
}

/**
 * Apply only mutations made after an authority view was created onto the
 * durable source config. This is for mixed read/write routes (wallet refresh):
 * the network read sees staging, while an unrelated persisted production or
 * self-hosted Cloud topology is neither contacted nor overwritten.
 */
export function mergeDevCloudConfigAuthorityMutation<T extends object>(
  durable: T,
  authorityViewBeforeMutation: T,
  authorityViewAfterMutation: T,
): T {
  if (!isDevCloudConfigAuthorityView(authorityViewBeforeMutation)) {
    return authorityViewAfterMutation;
  }
  return applyConfigMutationDelta(
    durable,
    authorityViewBeforeMutation,
    authorityViewAfterMutation,
  ) as T;
}
