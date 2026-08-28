/**
 * Resolves one Cloud environment for local API and renderer development.
 * Staging is the safe default; production, offline, and self-hosted tuples
 * require an explicit selector or complete low-level endpoint configuration.
 */

const TARGET_FLAG = "--cloud-target";
const TARGET_ENV = "ELIZA_DEV_CLOUD_TARGET";
const ENV_AUTHORITY_KEY = "ELIZA_DEV_CLOUD_ENV_AUTHORITY";
const DEFAULT_TARGET = "staging";
const VALID_TARGETS = new Set(["staging", "production", "offline"]);

const TARGET_CONFIG = Object.freeze({
  staging: Object.freeze({
    cloudApiBase: "https://api-staging.eliza.app/api/v1",
    cloudAppBase: "https://cloud-staging.eliza.app",
    stewardApiUrl: "https://staging.eliza.app/steward",
    stewardTenantId: "elizacloud-staging",
  }),
  production: Object.freeze({
    cloudApiBase: "https://api.eliza.app/api/v1",
    cloudAppBase: "https://cloud.eliza.app",
    stewardApiUrl: "https://eliza.app/steward",
    stewardTenantId: "elizacloud",
  }),
});

const CLOUD_ACTIVATION_KEYS = Object.freeze([
  "ELIZA_DEV_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_SERVICE_KEY",
  "ELIZAOS_CLOUD_EMBEDDING_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_USE_INFERENCE",
  "ELIZAOS_CLOUD_USE_TTS",
  "ELIZAOS_CLOUD_USE_STT",
  "ELIZAOS_CLOUD_USE_MEDIA",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_RPC",
  "ELIZA_CLOUD_API_KEY",
  "ELIZA_CLOUD_SERVICE_KEY",
  "ELIZA_CLOUD_SERVICE_TOKEN",
  "ELIZA_CLOUD_SESSION_TOKEN",
  "ELIZA_CLOUD_TOKEN",
  "ELIZACLOUD_API_KEY",
  "ELIZACLOUD_TOKEN",
  "ELIZA_CLOUD_AUTH_TOKEN",
  "ELIZA_CLOUD_SANDBOX_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_CLOUD_AGENT_ID",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
  "ELIZAOS_CLOUD_AGENT_ID",
]);

// Operational Steward credentials can query, create, sign with, or trade from
// wallets. The safe default and offline targets clear every such value;
// explicit targets retain only launch-supplied identity/auth while stamping
// the selected target's exact URL and tenant.
const STEWARD_OPERATIONAL_KEYS = Object.freeze([
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_TRADE_SESSION_ID",
  "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
  "STEWARD_POLYMARKET_TRADE_SESSION_ID",
]);

// Alternative endpoint families are read ahead of the canonical base by
// embedding and remote-runner clients. Hosted targets clear them and stamp the
// exact canonical tuple; only a complete self-hosted tuple may retain them.
const CLOUD_ENDPOINT_OVERRIDE_KEYS = Object.freeze([
  "ELIZAOS_CLOUD_BROWSER_BASE_URL",
  "ELIZAOS_CLOUD_BROWSER_EMBEDDING_URL",
  "ELIZAOS_CLOUD_EMBEDDING_URL",
  "ELIZAOS_CLOUD_API_BASE_URL",
  "ELIZAOS_CLOUD_REQUEST_BASE_URL",
  "ELIZAOS_CLOUD_URL",
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
]);

const CANONICAL_PRODUCTION_HOSTS = new Set([
  "eliza.app",
  "cloud.eliza.app",
  "api.eliza.app",
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "app.elizacloud.ai",
  "api.elizacloud.ai",
]);
const CANONICAL_STAGING_HOSTS = new Set([
  "staging.eliza.app",
  "cloud-staging.eliza.app",
  "api-staging.eliza.app",
  "staging.elizacloud.ai",
  "app-staging.elizacloud.ai",
  "api-staging.elizacloud.ai",
]);

function configuredValue(env, key) {
  const value = env[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function usableCloudCredential(env, key) {
  const value = configuredValue(env, key);
  if (
    !value ||
    value.toUpperCase() === "[REDACTED]" ||
    value.toLowerCase().startsWith("vault://")
  ) {
    return undefined;
  }
  return value;
}

function selectedCanonicalCloudApiKey(
  env,
  { includeStagingSpecific = false } = {},
) {
  return (
    usableCloudCredential(env, "ELIZAOS_CLOUD_API_KEY") ??
    (includeStagingSpecific
      ? usableCloudCredential(env, "ELIZA_DEV_CLOUD_API_KEY")
      : undefined) ??
    usableCloudCredential(env, "ELIZA_CLOUD_API_KEY") ??
    usableCloudCredential(env, "ELIZACLOUD_API_KEY")
  );
}

function promoteCanonicalCloudApiKey(env, options) {
  const selected = selectedCanonicalCloudApiKey(env, options);
  if (selected) env.ELIZAOS_CLOUD_API_KEY = selected;
  // Downstream legacy consumers use different precedence orders. Leave one
  // canonical credential so they cannot select a conflicting inherited alias.
  env.ELIZA_DEV_CLOUD_API_KEY = "";
  env.ELIZA_CLOUD_API_KEY = "";
  env.ELIZACLOUD_API_KEY = "";
}

function hasSecureStewardApiUrl(value) {
  if (!value || !URL.canParse(value)) return false;
  const parsed = new URL(value);
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname)
  );
}

function enforceCoherentOperationalStewardTuple(env) {
  const apiUrl = configuredValue(env, "STEWARD_API_URL");
  const primaryAgentId = configuredValue(env, "STEWARD_AGENT_ID");
  const aliasAgentId = configuredValue(env, "ELIZA_STEWARD_AGENT_ID");
  const tenantId = configuredValue(env, "STEWARD_TENANT_ID");
  const apiKey = usableCloudCredential(env, "STEWARD_API_KEY");
  const agentToken = usableCloudCredential(env, "STEWARD_AGENT_TOKEN");
  const agentIdsConflict = Boolean(
    primaryAgentId && aliasAgentId && primaryAgentId !== aliasAgentId,
  );
  const complete = Boolean(
    hasSecureStewardApiUrl(apiUrl) &&
      (primaryAgentId || aliasAgentId) &&
      !agentIdsConflict &&
      (agentToken || (apiKey && tenantId)) &&
      (!apiKey || tenantId),
  );
  if (!complete) {
    for (const key of STEWARD_OPERATIONAL_KEYS) env[key] = "";
  }
}

function parseEndpointUrl(value, key) {
  if (!URL.canParse(value)) {
    throw new Error(`${key} must be an absolute HTTP(S) URL, not "${value}".`);
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${key} must use HTTP(S), not "${parsed.protocol}".`);
  }
  return parsed;
}

function canonicalEnvironmentForUrl(value, key) {
  const hostname = parseEndpointUrl(value, key).hostname.toLowerCase();
  if (
    CANONICAL_STAGING_HOSTS.has(hostname) ||
    hostname.endsWith(".cloud-staging.eliza.app") ||
    hostname.endsWith(".staging.elizacloud.ai")
  ) {
    return "staging";
  }
  if (
    CANONICAL_PRODUCTION_HOSTS.has(hostname) ||
    hostname.endsWith(".cloud.eliza.app") ||
    hostname.endsWith(".elizacloud.ai")
  ) {
    return "production";
  }
  return null;
}

function canonicalEnvironmentForTenant(value) {
  const tenant = value.trim().toLowerCase();
  if (tenant === "elizacloud-staging") return "staging";
  if (tenant === "elizacloud") return "production";
  return null;
}

function canonicalEnvironmentEntries(env) {
  const entries = [];
  for (const key of [
    "ELIZAOS_CLOUD_BASE_URL",
    "VITE_ELIZA_CLOUD_BASE",
    "VITE_STEWARD_API_URL",
  ]) {
    const value = configuredValue(env, key);
    const environment = value ? canonicalEnvironmentForUrl(value, key) : null;
    if (environment) entries.push({ key, environment });
  }

  const tenant = configuredValue(env, "VITE_STEWARD_TENANT_ID");
  const tenantEnvironment = tenant
    ? canonicalEnvironmentForTenant(tenant)
    : null;
  if (tenantEnvironment) {
    entries.push({
      key: "VITE_STEWARD_TENANT_ID",
      environment: tenantEnvironment,
    });
  }
  return entries;
}

function inspectCustomCloudBases(env) {
  const apiBase = configuredValue(env, "ELIZAOS_CLOUD_BASE_URL");
  const rendererBase = configuredValue(env, "VITE_ELIZA_CLOUD_BASE");
  const apiEnvironment = apiBase
    ? canonicalEnvironmentForUrl(apiBase, "ELIZAOS_CLOUD_BASE_URL")
    : null;
  const rendererEnvironment = rendererBase
    ? canonicalEnvironmentForUrl(rendererBase, "VITE_ELIZA_CLOUD_BASE")
    : null;
  const apiCustom = Boolean(apiBase && !apiEnvironment);
  const rendererCustom = Boolean(rendererBase && !rendererEnvironment);

  if (apiCustom !== rendererCustom) {
    throw new Error(
      "Self-hosted dev Cloud configuration must set both ELIZAOS_CLOUD_BASE_URL and VITE_ELIZA_CLOUD_BASE to non-canonical endpoints so the API and renderer cannot diverge.",
    );
  }
  if (!apiCustom) return false;

  const stewardApiUrl = configuredValue(env, "VITE_STEWARD_API_URL");
  if (stewardApiUrl) {
    parseEndpointUrl(stewardApiUrl, "VITE_STEWARD_API_URL");
  }
  return true;
}

function validateTargetValue(raw, source) {
  const target = raw.trim().toLowerCase();
  if (!VALID_TARGETS.has(target)) {
    throw new Error(
      `Unknown dev Cloud target "${raw}" from ${source}. Expected "staging", "production", or "offline".`,
    );
  }
  return target;
}

/** Resolve the high-level target and remove its dev-only flag from child args. */
export function resolveDevCloudTarget(args = [], env = process.env) {
  const passthroughArgs = [];
  let cliValue;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === TARGET_FLAG) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(
          'Dev Cloud target is missing. Expected "staging", "production", or "offline".',
        );
      }
      if (cliValue !== undefined) {
        throw new Error("Dev Cloud target may be supplied only once.");
      }
      cliValue = value;
      index += 1;
      continue;
    }
    if (arg.startsWith(`${TARGET_FLAG}=`)) {
      const value = arg.slice(`${TARGET_FLAG}=`.length);
      if (!value) {
        throw new Error(
          'Dev Cloud target is missing. Expected "staging", "production", or "offline".',
        );
      }
      if (cliValue !== undefined) {
        throw new Error("Dev Cloud target may be supplied only once.");
      }
      cliValue = value;
      continue;
    }
    passthroughArgs.push(arg);
  }

  if (cliValue !== undefined) {
    return {
      target: validateTargetValue(cliValue, TARGET_FLAG),
      source: "cli",
      passthroughArgs,
    };
  }

  const envValue = configuredValue(env, TARGET_ENV);
  if (envValue) {
    return {
      target: validateTargetValue(envValue, TARGET_ENV),
      source: "env",
      passthroughArgs,
    };
  }

  return {
    target: DEFAULT_TARGET,
    source: "default",
    passthroughArgs,
  };
}

function buildDevCloudPlan(env, resolution) {
  // The explicit offline selector is an escape hatch from every inherited
  // hosted or self-hosted value, including values loaded by a shell profile.
  if (resolution.target === "offline") {
    return { effectiveTarget: "offline", selfHosted: false };
  }

  const selfHosted = inspectCustomCloudBases(env);
  if (selfHosted && resolution.source !== "default") {
    throw new Error(
      `Explicit dev Cloud target "${resolution.target}" conflicts with the self-hosted ELIZAOS_CLOUD_BASE_URL and VITE_ELIZA_CLOUD_BASE tuple. Remove ${TARGET_FLAG}/${TARGET_ENV} to use self-hosted development.`,
    );
  }

  if (selfHosted) {
    if (!selectedCanonicalCloudApiKey(env, { includeStagingSpecific: true })) {
      throw new Error(
        "Self-hosted local development requires ELIZAOS_CLOUD_API_KEY (or a supported legacy alias). The immutable launcher target cannot acquire or replace its server credential through the local agent proxy.",
      );
    }
    const runtimeMode = configuredValue(env, "VITE_ELIZA_DESKTOP_RUNTIME_MODE");
    if (runtimeMode && runtimeMode !== "cloud") {
      throw new Error(
        `Self-hosted dev Cloud configuration requires VITE_ELIZA_DESKTOP_RUNTIME_MODE=cloud, not "${runtimeMode}".`,
      );
    }
    return { effectiveTarget: "self-hosted", selfHosted: true };
  }

  const conflicts = canonicalEnvironmentEntries(env).filter(
    ({ environment }) => environment !== resolution.target,
  );
  if (conflicts.length > 0) {
    const details = conflicts
      .map(({ key, environment }) => `${key}=${environment}`)
      .join(", ");
    throw new Error(
      `Dev Cloud target "${resolution.target}" conflicts with canonical configuration: ${details}. Select one environment for the API, renderer, Steward URL, and tenant.`,
    );
  }

  const runtimeMode = configuredValue(env, "VITE_ELIZA_DESKTOP_RUNTIME_MODE");
  if (runtimeMode && runtimeMode !== "cloud") {
    throw new Error(
      `Dev Cloud target "${resolution.target}" requires VITE_ELIZA_DESKTOP_RUNTIME_MODE=cloud, not "${runtimeMode}". Use --cloud-target=offline for the runtime chooser.`,
    );
  }
  if (
    resolution.target === "production" &&
    !selectedCanonicalCloudApiKey(env)
  ) {
    throw new Error(
      "Production local development requires ELIZAOS_CLOUD_API_KEY (or a supported legacy alias). Production intentionally rejects loopback browser authentication, so the credential must be supplied at launch.",
    );
  }
  return { effectiveTarget: resolution.target, selfHosted: false };
}

/** Return a fresh environment with one coherent API/renderer Cloud policy. */
export function applyDevCloudTarget(env, resolution) {
  const plan = buildDevCloudPlan(env, resolution);
  const explicitStagingApiKey =
    plan.effectiveTarget === "staging" && resolution.source !== "default"
      ? usableCloudCredential(env, "ELIZA_DEV_CLOUD_API_KEY")
      : undefined;
  const authority =
    plan.effectiveTarget === "staging"
      ? resolution.source === "default"
        ? "staging-default"
        : "staging-explicit"
      : plan.effectiveTarget;
  const nextEnv = {
    ...env,
    ELIZA_DEV_SOURCE: "1",
    [ENV_AUTHORITY_KEY]: authority,
  };
  // A CLI selector outranks an inherited process selector. Reflect that choice
  // in children as well so nested tooling cannot observe a stale target.
  if (resolution.source === "cli") {
    nextEnv[TARGET_ENV] = resolution.target;
  }

  if (plan.effectiveTarget === "offline") {
    // Local-first development must not auto-load the Cloud plugin, but the
    // chooser still contains an explicit Cloud option. Keep that manual path
    // on staging instead of letting blank renderer values fall back to prod.
    const staging = TARGET_CONFIG.staging;
    nextEnv.ELIZAOS_CLOUD_BASE_URL = staging.cloudApiBase;
    for (const key of CLOUD_ACTIVATION_KEYS) nextEnv[key] = "";
    for (const key of STEWARD_OPERATIONAL_KEYS) nextEnv[key] = "";
    for (const key of CLOUD_ENDPOINT_OVERRIDE_KEYS) nextEnv[key] = "";
    nextEnv.VITE_ELIZA_CLOUD_BASE = staging.cloudAppBase;
    nextEnv.VITE_STEWARD_API_URL = staging.stewardApiUrl;
    nextEnv.VITE_STEWARD_TENANT_ID = staging.stewardTenantId;
    nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "";
    nextEnv.VITE_ELIZA_ENABLE_RUNTIME_CHOOSER = "1";
    return nextEnv;
  }

  if (plan.selfHosted) {
    promoteCanonicalCloudApiKey(nextEnv, { includeStagingSpecific: true });
    enforceCoherentOperationalStewardTuple(nextEnv);
    nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE =
      configuredValue(env, "VITE_ELIZA_DESKTOP_RUNTIME_MODE") ?? "cloud";
    return nextEnv;
  }

  const config = TARGET_CONFIG[resolution.target];
  // A named hosted target is an exact environment tuple, not a loose hostname
  // classification. Overwrite inherited paths and standalone Steward values so
  // local auth, API, wallet, and renderer surfaces cannot silently diverge.
  for (const key of CLOUD_ENDPOINT_OVERRIDE_KEYS) nextEnv[key] = "";
  nextEnv.ELIZAOS_CLOUD_BASE_URL = config.cloudApiBase;
  nextEnv.VITE_ELIZA_CLOUD_BASE = config.cloudAppBase;
  nextEnv.VITE_STEWARD_API_URL = config.stewardApiUrl;
  nextEnv.VITE_STEWARD_TENANT_ID = config.stewardTenantId;
  nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "cloud";

  // A staging selector chooses an endpoint, not an ambient credential trust
  // boundary. Generic Cloud and Steward values may belong to production, so
  // every staging launch scrubs them. An operator who deliberately needs a
  // staging server credential must use the target-specific
  // ELIZA_DEV_CLOUD_API_KEY; keyless hosted-session login remains supported.
  if (resolution.target === "staging") {
    for (const key of CLOUD_ACTIVATION_KEYS) nextEnv[key] = "";
    for (const key of STEWARD_OPERATIONAL_KEYS) nextEnv[key] = "";
    if (explicitStagingApiKey) {
      nextEnv.ELIZAOS_CLOUD_API_KEY = explicitStagingApiKey;
    }
  } else {
    nextEnv.STEWARD_API_URL = config.stewardApiUrl;
    nextEnv.STEWARD_TENANT_ID = config.stewardTenantId;
    promoteCanonicalCloudApiKey(nextEnv);
    enforceCoherentOperationalStewardTuple(nextEnv);
  }
  return nextEnv;
}

/** Resolve arguments and environment together for a development entrypoint. */
export function configureDevCloudEnvironment(args = [], env = process.env) {
  const resolution = resolveDevCloudTarget(args, env);
  const plan = buildDevCloudPlan(env, resolution);
  return {
    ...resolution,
    effectiveTarget: plan.effectiveTarget,
    env: applyDevCloudTarget(env, resolution),
  };
}

/**
 * Refuse targets that require a server-held credential when an entrypoint only
 * starts the renderer. Production does not grant localhost browser auth, and a
 * self-hosted deployment is not guaranteed to expose a browser-safe auth
 * exchange. Passing the launch key through Vite would turn the workaround into
 * a credential disclosure, so these targets must use the repo-root orchestrator
 * that owns a local agent backend.
 */
export function assertRendererOnlyDevCloudTargetSupported(
  configured,
  entrypoint = "renderer-only development",
) {
  if (
    configured?.effectiveTarget === "staging" ||
    configured?.effectiveTarget === "offline"
  ) {
    return;
  }

  const target = configured?.effectiveTarget ?? "unknown";
  throw new Error(
    `${entrypoint} cannot use Cloud target "${target}" without a local agent backend. The launch credential stays server-side and is never exposed to Vite. Run the repo-root \`bun run dev\` command for production or self-hosted development.`,
  );
}
