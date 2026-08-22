/**
 * Builds the OpenCode-specific ACP spawn configuration and environment: the
 * provider/model wiring (Eliza Cloud OpenAI-compatible endpoint or Cerebras),
 * the vendored OpenCode shim path, and the read-only web-fetch/web-search
 * permission grant a spawned sub-agent needs to reach the network under the
 * non-interactive approval preset.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { DEFAULT_CEREBRAS_TEXT_MODEL, ElizaError } from "@elizaos/core";
import { readConfigCloudKey, readConfigEnvKey } from "./config-env.js";
import { resolveModelGatewayConfig } from "./model-gateway.js";
import { classifyIpLiteral } from "./ssrf-guard.js";

const ELIZA_CLOUD_OPENAI_BASE = "https://api.eliza.app/api/v1";
const OPENCODE_LOCAL_DEFAULT_BASE_URL = "http://localhost:11434/v1";
const OPENCODE_OPENAI_COMPATIBLE_NPM = "@ai-sdk/openai-compatible";
const OPENCODE_CEREBRAS_NPM = "@ai-sdk/cerebras";
const CEREBRAS_DEFAULT_BASE_URL = "https://api.cerebras.ai/v1";
const CEREBRAS_DEFAULT_MODEL = DEFAULT_CEREBRAS_TEXT_MODEL;

export type OpencodeApiBillingMode = "api-payg" | "api-credits-or-byok";

export type OpencodeApiProviderId =
  | "cerebras-api"
  | "deepseek-api"
  | "zai-api"
  | "moonshot-api"
  | "xai-api"
  | "openrouter-api";

export interface OpencodeApiRoute {
  accountProviderId: OpencodeApiProviderId;
  providerId: string;
  providerLabel: string;
  keyEnv: string;
  keyEnvAliases?: readonly string[];
  baseUrlEnv: readonly string[];
  defaultBaseUrl: string;
  defaultModel?: string;
  authHeader: "Authorization: Bearer";
  billingMode: OpencodeApiBillingMode;
  termsPolicy: "direct-api" | "credits-or-byok";
  headers?: Readonly<Record<string, string>>;
}

/**
 * Direct billing routes OpenCode can consume. Coding-plan endpoint keys are
 * intentionally absent: Kimi and Z.AI subscription quota have distinct keys,
 * endpoints, and terms, and must never be inferred from these PAYG entries.
 */
export const OPENCODE_API_ROUTES = {
  "cerebras-api": {
    accountProviderId: "cerebras-api",
    providerId: "cerebras",
    providerLabel: "Cerebras API",
    keyEnv: "CEREBRAS_API_KEY",
    baseUrlEnv: ["CEREBRAS_BASE_URL"],
    defaultBaseUrl: CEREBRAS_DEFAULT_BASE_URL,
    defaultModel: CEREBRAS_DEFAULT_MODEL,
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
  },
  "deepseek-api": {
    accountProviderId: "deepseek-api",
    providerId: "deepseek",
    providerLabel: "DeepSeek API (PAYG)",
    keyEnv: "DEEPSEEK_API_KEY",
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-pro",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
  },
  "zai-api": {
    accountProviderId: "zai-api",
    providerId: "zai",
    providerLabel: "Z.AI API (PAYG)",
    keyEnv: "ZAI_API_KEY",
    keyEnvAliases: ["Z_AI_API_KEY"],
    baseUrlEnv: ["ZAI_BASE_URL", "Z_AI_BASE_URL"],
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    defaultModel: "glm-5.1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
  },
  "moonshot-api": {
    accountProviderId: "moonshot-api",
    providerId: "moonshot",
    providerLabel: "Kimi / Moonshot API (PAYG)",
    keyEnv: "MOONSHOT_API_KEY",
    keyEnvAliases: ["KIMI_API_KEY"],
    baseUrlEnv: ["MOONSHOT_BASE_URL", "KIMI_BASE_URL"],
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    defaultModel: "kimi-k2.5",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
  },
  "xai-api": {
    accountProviderId: "xai-api",
    providerId: "xai",
    providerLabel: "xAI API (PAYG)",
    keyEnv: "XAI_API_KEY",
    baseUrlEnv: ["XAI_BASE_URL"],
    defaultBaseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-build-0.1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-payg",
    termsPolicy: "direct-api",
  },
  "openrouter-api": {
    accountProviderId: "openrouter-api",
    providerId: "openrouter",
    providerLabel: "OpenRouter credits / BYOK",
    keyEnv: "OPENROUTER_API_KEY",
    baseUrlEnv: ["OPENROUTER_BASE_URL"],
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    authHeader: "Authorization: Bearer",
    billingMode: "api-credits-or-byok",
    termsPolicy: "credits-or-byok",
    headers: {
      "HTTP-Referer": "https://elizaos.ai",
      "X-OpenRouter-Title": "elizaOS coding agent",
    },
  },
} as const satisfies Readonly<Record<OpencodeApiProviderId, OpencodeApiRoute>>;

export const OPENCODE_API_KEY_ENVS = Object.freeze(
  Object.values(OPENCODE_API_ROUTES).flatMap((route) => [
    route.keyEnv,
    ...("keyEnvAliases" in route ? route.keyEnvAliases : []),
  ]),
);

function routeCredentialKeys(route: OpencodeApiRoute): readonly string[] {
  return [route.keyEnv, ...(route.keyEnvAliases ?? [])];
}

// `webfetch` is a read-only HTTP GET (opencode caps the response at 5MB and
// never mutates the workspace). `websearch` is opencode's general web-search
// tool — a read-only query against the keyless Parallel.ai / Exa MCP search
// endpoints (no PARALLEL_API_KEY required; the tool sends only a User-Agent
// when none is set). opencode defaults BOTH permissions to "ask", so under the
// acpx "standard" approval preset (which answers non-interactive permission
// prompts with "deny") a spawned sub-agent's fetch AND search are silently
// denied — and the model, unable to reach the network, either confabulates an
// answer or falls back to `webfetch` on a guessed search URL (e.g.
// google.com/search), which datacenter IPs get bot-blocked from ("trouble
// accessing Google Search"). Allowing both read-only capabilities lets
// sub-agents do real general web search + live fetches on any provider without
// granting write/exec (`bash`, `edit`) permissions, which stay gated by the
// preset.
//
// SECURITY: read-only does not mean safe-target. opencode's own SSRF guard is
// what blocks fetches to loopback, private ranges, and cloud metadata
// (169.254.169.254). This grant assumes that guard is deployed in the bundled
// opencode build; without it a spawned sub-agent can reach internal endpoints.
const OPENCODE_SPAWN_PERMISSION = {
  webfetch: "allow",
  websearch: "allow",
} as const;

type RuntimeLike = Pick<IAgentRuntime, "getSetting">;

export interface OpencodeSpawnConfig {
  configContent: string;
  providerLabel: string;
  providerId: string;
  accountProviderId?: OpencodeApiProviderId;
  billingMode?: OpencodeApiBillingMode;
  termsPolicy?: OpencodeApiRoute["termsPolicy"];
  baseUrl?: string;
  model: string;
  smallModel?: string;
}

export interface OpencodeAcpEnvResult {
  env: Record<string, string>;
  config?: OpencodeSpawnConfig;
  vendoredShimDir?: string;
}

export interface OpencodeAccountRouteOverride {
  providerId: string;
  credentials: Readonly<Record<string, string | undefined>>;
}

/** Removes URL components that may carry credentials before structured logging. */
export function safeOpencodeEndpointForLog(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    // error-policy:J3 logging untrusted configuration must never echo it when
    // it is not a parseable URL.
    return undefined;
  }
}

function runtimeSetting(
  runtime: RuntimeLike | undefined,
  key: string,
): string | undefined {
  const value = runtime?.getSetting?.(key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setting(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  key: string,
): string | undefined {
  const fromRuntime = runtimeSetting(runtime, key);
  if (fromRuntime) return fromRuntime;
  const fromEnv = env?.[key];
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  if (env && env !== process.env) return undefined;
  const fromConfig = readConfigEnvKey(key);
  return fromConfig?.trim() || undefined;
}

function providerConfig(
  providerId: string,
  name: string,
  npm: string,
  baseURL: string,
  apiKey: string | undefined,
  powerful: string,
  fast: string | undefined,
  metadata: Pick<
    OpencodeSpawnConfig,
    "accountProviderId" | "billingMode" | "termsPolicy"
  > = {},
  headers?: Readonly<Record<string, string>>,
): OpencodeSpawnConfig {
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      [providerId]: {
        npm,
        name,
        options: {
          baseURL,
          ...(apiKey ? { apiKey } : {}),
          ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
        },
        models: {
          [powerful]: { name: powerful },
          ...(fast && fast !== powerful ? { [fast]: { name: fast } } : {}),
        },
      },
    },
    model: `${providerId}/${powerful}`,
    ...(fast && fast !== powerful
      ? { small_model: `${providerId}/${fast}` }
      : {}),
    permission: OPENCODE_SPAWN_PERMISSION,
  };
  return {
    configContent: JSON.stringify(config),
    providerLabel: name,
    providerId,
    ...metadata,
    baseUrl: baseURL,
    model: `${providerId}/${powerful}`,
    smallModel: fast && fast !== powerful ? `${providerId}/${fast}` : undefined,
  };
}

function firstSetting(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = setting(runtime, env, key);
    if (value) return value;
  }
  return undefined;
}

function normalizeRouteId(
  value: string | undefined,
): OpencodeApiProviderId | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  const aliases: Readonly<Record<string, OpencodeApiProviderId>> = {
    cerebras: "cerebras-api",
    "cerebras-api": "cerebras-api",
    deepseek: "deepseek-api",
    "deepseek-api": "deepseek-api",
    zai: "zai-api",
    "z.ai": "zai-api",
    "zai-api": "zai-api",
    moonshot: "moonshot-api",
    kimi: "moonshot-api",
    "moonshot-api": "moonshot-api",
    xai: "xai-api",
    grok: "xai-api",
    "xai-api": "xai-api",
    openrouter: "openrouter-api",
    "openrouter-api": "openrouter-api",
  };
  return aliases[normalized];
}

function explicitlySelectedRoute(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  accountRoute: OpencodeAccountRouteOverride | undefined,
): OpencodeApiProviderId | undefined {
  const accountProviderId = normalizeRouteId(accountRoute?.providerId);
  if (accountRoute && !accountProviderId) {
    throw new ElizaError(
      `Unsupported selected OpenCode API provider: ${accountRoute.providerId}`,
      {
        code: "OPENCODE_PROVIDER_UNSUPPORTED",
        context: { providerId: accountRoute.providerId },
        severity: "fatal",
      },
    );
  }
  if (accountProviderId) return accountProviderId;
  const raw =
    setting(runtime, env, "ELIZA_OPENCODE_PROVIDER_ID") ??
    setting(runtime, env, "ELIZA_OPENCODE_PROVIDER");
  if (!raw) return undefined;
  const providerId = normalizeRouteId(raw);
  if (!providerId) {
    throw new ElizaError(`Unsupported OpenCode API provider: ${raw}`, {
      code: "OPENCODE_PROVIDER_UNSUPPORTED",
      context: { providerId: raw },
      severity: "fatal",
    });
  }
  return providerId;
}

function autoDetectedRoute(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): OpencodeApiProviderId | undefined {
  const found = Object.values(OPENCODE_API_ROUTES).filter((route) =>
    usableApiKey(firstSetting(runtime, env, routeCredentialKeys(route))),
  );
  if (found.length === 1) return found[0]?.accountProviderId;
  // Preserve the historical Cerebras default on hosts with several general
  // inference keys. A different provider must be selected explicitly so the
  // provider/account/model/billing tuple cannot depend on object order.
  if (found.some((route) => route.accountProviderId === "cerebras-api")) {
    return "cerebras-api";
  }
  return undefined;
}

function buildTypedApiRouteConfig(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  routeId: OpencodeApiProviderId,
  powerfulOverride: string | undefined,
  fastOverride: string | undefined,
  accountRoute: OpencodeAccountRouteOverride | undefined,
): OpencodeSpawnConfig {
  const route: OpencodeApiRoute = OPENCODE_API_ROUTES[routeId];
  const apiKey = usableApiKey(
    accountRoute
      ? firstSetting(
          undefined,
          accountRoute.credentials,
          routeCredentialKeys(route),
        )
      : firstSetting(runtime, env, routeCredentialKeys(route)),
  );
  if (!apiKey) {
    throw new ElizaError(
      `${route.providerLabel} requires ${route.keyEnv} for direct API billing.`,
      {
        code: "OPENCODE_PROVIDER_CREDENTIAL_MISSING",
        context: { providerId: route.accountProviderId, keyEnv: route.keyEnv },
        severity: "fatal",
      },
    );
  }
  const providerPrefix = `${route.providerId}/`;
  const powerful =
    powerfulOverride?.startsWith(providerPrefix) === true
      ? powerfulOverride.slice(providerPrefix.length)
      : (powerfulOverride ?? route.defaultModel);
  if (!powerful) {
    throw new ElizaError(
      `${route.providerLabel} requires an explicit OpenCode model.`,
      {
        code: "OPENCODE_PROVIDER_MODEL_MISSING",
        context: {
          providerId: route.accountProviderId,
          modelSetting: "ELIZA_OPENCODE_MODEL_POWERFUL",
        },
        severity: "fatal",
      },
    );
  }
  if (
    powerful.length > 256 ||
    !/^[~A-Za-z0-9][A-Za-z0-9._:/+~-]*$/.test(powerful)
  ) {
    throw new ElizaError(
      `${route.providerLabel} received an invalid OpenCode model id.`,
      {
        code: "OPENCODE_PROVIDER_MODEL_INVALID",
        context: { providerId: route.accountProviderId },
        severity: "fatal",
      },
    );
  }
  const configuredBaseUrl =
    firstSetting(runtime, env, route.baseUrlEnv) ?? route.defaultBaseUrl;
  let baseUrl: string;
  try {
    const parsed = new URL(configuredBaseUrl);
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback =
      host === "localhost" || classifyIpLiteral(host) === "loopback";
    if (
      (parsed.protocol !== "https:" &&
        !(parsed.protocol === "http:" && isLoopback)) ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(
        "expected an HTTPS URL without credentials, query, or fragment",
      );
    }
    baseUrl = parsed.toString().replace(/\/+$/, "");
  } catch (cause) {
    // error-policy:J3 provider endpoint configuration is untrusted operator
    // input; reject malformed or credential-bearing URLs before child spawn.
    throw new ElizaError(
      `${route.providerLabel} received an invalid API base URL.`,
      {
        code: "OPENCODE_PROVIDER_BASE_URL_INVALID",
        cause,
        context: { providerId: route.accountProviderId },
        severity: "fatal",
      },
    );
  }
  return providerConfig(
    route.providerId,
    route.providerLabel,
    route.accountProviderId === "cerebras-api"
      ? OPENCODE_CEREBRAS_NPM
      : OPENCODE_OPENAI_COMPATIBLE_NPM,
    baseUrl,
    apiKey,
    powerful,
    fastOverride,
    {
      accountProviderId: route.accountProviderId,
      billingMode: route.billingMode,
      termsPolicy: route.termsPolicy,
    },
    route.headers,
  );
}

function isCerebrasBaseUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "cerebras.ai" || hostname.endsWith(".cerebras.ai");
  } catch {
    // error-policy:J3 URL parse; an unparseable base URL is not a Cerebras host.
    return false;
  }
}

function usableApiKey(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("vault://")) return undefined;
  return value;
}

export function buildOpencodeSpawnConfig(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  overrideModel?: string,
  accountRoute?: OpencodeAccountRouteOverride,
): OpencodeSpawnConfig | null {
  const llmProvider =
    setting(runtime, env, "ELIZA_LLM_PROVIDER") || "subscription";
  const customBaseUrl = setting(runtime, env, "ELIZA_OPENCODE_BASE_URL");
  const cerebrasBaseUrl =
    setting(runtime, env, "CEREBRAS_BASE_URL") || CEREBRAS_DEFAULT_BASE_URL;
  const localOptIn = ["1", "true"].includes(
    (setting(runtime, env, "ELIZA_OPENCODE_LOCAL") ?? "").toLowerCase(),
  );
  const powerful =
    overrideModel?.trim() ||
    setting(runtime, env, "ELIZA_OPENCODE_MODEL_POWERFUL") ||
    setting(runtime, env, "OPENCODE_MODEL");
  const fast = setting(runtime, env, "ELIZA_OPENCODE_MODEL_FAST");

  // Gateway mode (#11536 E2) — checked BEFORE any provider-credential read so
  // no raw key (env, runtime settings, or config-env; `setting()` falls back
  // to all three) can be embedded into OPENCODE_CONFIG_CONTENT, and the
  // opencode child cannot bypass the gateway by talking to Cerebras / Eliza
  // Cloud / a custom base URL directly. Provider auto-detection and custom
  // base URLs are deliberately ignored here: gateway mode centralizes egress.
  // Model names pass through unchanged (the gateway routes by model name),
  // defaulting to the same chain the direct cerebras-api path uses, so
  // flipping the gateway on changes transport + credentials, never the model.
  const gateway = resolveModelGatewayConfig();
  if (gateway) {
    return providerConfig(
      "eliza-gateway",
      "Eliza Model Gateway",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      gateway.url,
      gateway.token,
      powerful ||
        setting(runtime, env, "CEREBRAS_MODEL") ||
        CEREBRAS_DEFAULT_MODEL,
      fast,
    );
  }

  if (llmProvider === "cloud") {
    const cloudKey = readConfigCloudKey("apiKey");
    if (!cloudKey) return null;
    return providerConfig(
      "elizacloud",
      "Eliza Cloud",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      ELIZA_CLOUD_OPENAI_BASE,
      cloudKey,
      powerful || "claude-opus-4-8",
      fast || "claude-haiku-4-5",
    );
  }

  const explicitRoute = explicitlySelectedRoute(runtime, env, accountRoute);
  const typedRoute = explicitRoute ?? autoDetectedRoute(runtime, env);
  if (typedRoute) {
    return buildTypedApiRouteConfig(
      runtime,
      env,
      typedRoute,
      powerful,
      fast,
      accountRoute,
    );
  }

  const opencodeApiKey = usableApiKey(
    setting(runtime, env, "ELIZA_OPENCODE_API_KEY"),
  );
  const cerebrasApiKey =
    usableApiKey(setting(runtime, env, "CEREBRAS_API_KEY")) ||
    usableApiKey(setting(runtime, env, "ELIZA_E2E_CEREBRAS_API_KEY"));
  const wantsCerebras =
    isCerebrasBaseUrl(customBaseUrl) ||
    Boolean(cerebrasApiKey) ||
    (!customBaseUrl &&
      !localOptIn &&
      Boolean(opencodeApiKey) &&
      isCerebrasBaseUrl(cerebrasBaseUrl));
  if (wantsCerebras && (opencodeApiKey || cerebrasApiKey || customBaseUrl)) {
    return providerConfig(
      "cerebras",
      "Cerebras",
      OPENCODE_CEREBRAS_NPM,
      customBaseUrl || cerebrasBaseUrl,
      opencodeApiKey || cerebrasApiKey,
      powerful ||
        setting(runtime, env, "CEREBRAS_MODEL") ||
        CEREBRAS_DEFAULT_MODEL,
      fast,
    );
  }

  if (localOptIn || customBaseUrl) {
    return providerConfig(
      "eliza-local",
      "Local model",
      OPENCODE_OPENAI_COMPATIBLE_NPM,
      customBaseUrl || OPENCODE_LOCAL_DEFAULT_BASE_URL,
      opencodeApiKey,
      powerful || "eliza-1-4b",
      fast,
    );
  }

  if (!powerful) return null;
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    model: powerful,
    ...(fast ? { small_model: fast } : {}),
    permission: OPENCODE_SPAWN_PERMISSION,
  };
  return {
    configContent: JSON.stringify(config),
    providerLabel: "User-configured opencode.json",
    providerId: "user",
    model: powerful,
    smallModel: fast,
  };
}

function parentDirs(start: string): string[] {
  const dirs: string[] = [];
  let current = path.resolve(start);
  while (!dirs.includes(current)) {
    dirs.push(current);
    const next = path.dirname(current);
    if (next === current) break;
    current = next;
  }
  return dirs;
}

function candidateRoots(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return Array.from(
    new Set([...parentDirs(process.cwd()), ...parentDirs(moduleDir)]),
  );
}

export function resolveVendoredOpencodeShim(): string | undefined {
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
  for (const root of candidateRoots()) {
    const shim = path.join(
      root,
      "plugins",
      "plugin-agent-orchestrator",
      "bin",
      executable,
    );
    if (existsSync(shim)) {
      return path.dirname(shim);
    }
  }
  return undefined;
}

function commandArg(value: string): string {
  return /^[A-Za-z0-9_/:.=+-]+$/.test(value) ? value : JSON.stringify(value);
}

export function resolveVendoredOpencodeAcpCommand(): string | undefined {
  const shimDir = resolveVendoredOpencodeShim();
  if (!shimDir) return undefined;
  const executable = process.platform === "win32" ? "opencode.cmd" : "opencode";
  return `${commandArg(path.join(shimDir, executable))} acp`;
}

export function prependPathDir(
  currentPath: string | undefined,
  dir: string,
): string {
  const parts = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  return [
    dir,
    ...parts.filter((part) => path.resolve(part) !== path.resolve(dir)),
  ].join(path.delimiter);
}

export function buildOpencodeAcpEnv(
  runtime: RuntimeLike | undefined,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  model?: string,
  accountRoute?: OpencodeAccountRouteOverride,
): OpencodeAcpEnvResult {
  const next: Record<string, string> = {};
  const vendoredShimDir = resolveVendoredOpencodeShim();
  if (vendoredShimDir) {
    next.PATH = prependPathDir(env.PATH, vendoredShimDir);
  }

  const config =
    buildOpencodeSpawnConfig(runtime, env, model, accountRoute) ?? undefined;
  if (config) {
    next.OPENCODE_CONFIG_CONTENT = config.configContent;
    next.OPENCODE_MODEL = config.model;
    if (config.smallModel) next.OPENCODE_SMALL_MODEL = config.smallModel;
  }

  next.OPENCODE_DISABLE_AUTOUPDATE =
    typeof env.OPENCODE_DISABLE_AUTOUPDATE === "string"
      ? env.OPENCODE_DISABLE_AUTOUPDATE
      : "1";
  next.OPENCODE_DISABLE_TERMINAL_TITLE =
    typeof env.OPENCODE_DISABLE_TERMINAL_TITLE === "string"
      ? env.OPENCODE_DISABLE_TERMINAL_TITLE
      : "1";

  return { env: next, config, vendoredShimDir };
}
