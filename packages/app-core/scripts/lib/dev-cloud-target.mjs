/**
 * Resolves one Cloud environment for local API and renderer development.
 * Staging is the safe default; production, offline, and self-hosted tuples
 * require an explicit selector or complete low-level endpoint configuration.
 */

const TARGET_FLAG = "--cloud-target";
const TARGET_ENV = "ELIZA_DEV_CLOUD_TARGET";
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
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_API_KEY",
  "ELIZACLOUD_API_KEY",
  "ELIZA_CLOUD_PROVISIONED",
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

function normalizedCustomCloudBase(value, key) {
  const parsed = parseEndpointUrl(value, key);
  const pathname = parsed.pathname
    .replace(/\/+$/, "")
    .replace(/\/api\/v1$/i, "");
  return `${parsed.origin}${pathname}`;
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

  if (
    normalizedCustomCloudBase(apiBase, "ELIZAOS_CLOUD_BASE_URL") !==
    normalizedCustomCloudBase(rendererBase, "VITE_ELIZA_CLOUD_BASE")
  ) {
    throw new Error(
      "Self-hosted ELIZAOS_CLOUD_BASE_URL and VITE_ELIZA_CLOUD_BASE must identify the same Cloud endpoint (an optional /api/v1 suffix is ignored).",
    );
  }

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
  return { effectiveTarget: resolution.target, selfHosted: false };
}

/** Return a fresh environment with one coherent API/renderer Cloud policy. */
export function applyDevCloudTarget(env, resolution) {
  const plan = buildDevCloudPlan(env, resolution);
  const nextEnv = { ...env, ELIZA_DEV_SOURCE: "1" };
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
    nextEnv.VITE_ELIZA_CLOUD_BASE = staging.cloudAppBase;
    nextEnv.VITE_STEWARD_API_URL = staging.stewardApiUrl;
    nextEnv.VITE_STEWARD_TENANT_ID = staging.stewardTenantId;
    nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "";
    nextEnv.VITE_ELIZA_ENABLE_RUNTIME_CHOOSER = "1";
    return nextEnv;
  }

  if (plan.selfHosted) {
    nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE =
      configuredValue(env, "VITE_ELIZA_DESKTOP_RUNTIME_MODE") ?? "cloud";
    return nextEnv;
  }

  const config = TARGET_CONFIG[resolution.target];
  nextEnv.ELIZAOS_CLOUD_BASE_URL =
    configuredValue(env, "ELIZAOS_CLOUD_BASE_URL") ?? config.cloudApiBase;
  nextEnv.VITE_ELIZA_CLOUD_BASE =
    configuredValue(env, "VITE_ELIZA_CLOUD_BASE") ?? config.cloudAppBase;
  nextEnv.VITE_STEWARD_API_URL =
    configuredValue(env, "VITE_STEWARD_API_URL") ?? config.stewardApiUrl;
  nextEnv.VITE_STEWARD_TENANT_ID =
    configuredValue(env, "VITE_STEWARD_TENANT_ID") ?? config.stewardTenantId;
  nextEnv.VITE_ELIZA_DESKTOP_RUNTIME_MODE = "cloud";

  // Ordinary `bun run dev` must never reinterpret a generic production key
  // injected by a shell or CI environment as a staging credential. Operators
  // who deliberately need a staging runtime key opt in with the explicit
  // `staging` selector; production and self-hosted targets are already
  // explicit and retain their supplied credentials.
  if (resolution.target === "staging" && resolution.source === "default") {
    for (const key of CLOUD_ACTIVATION_KEYS) nextEnv[key] = "";
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
