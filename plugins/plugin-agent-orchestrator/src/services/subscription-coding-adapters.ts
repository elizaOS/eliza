/**
 * Defines the sanctioned subscription-backed Kimi Code and Grok Build ACP
 * boundaries. The descriptors keep included-plan OAuth sessions separate from
 * direct API billing, while local probes fail before spawn when the runtime,
 * platform, login, or execution policy is not usable.
 */
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ElizaError } from "@elizaos/core";
import { parse as parseToml } from "smol-toml";
import type { SubscriptionExecutionMode } from "./types.js";

export const SUBSCRIPTION_CODING_ADAPTER_IDS = ["kimi", "grok"] as const;

export type SubscriptionCodingAdapterId =
  (typeof SUBSCRIPTION_CODING_ADAPTER_IDS)[number];

export type { SubscriptionExecutionMode } from "./types.js";

export interface SubscriptionBillingSource {
  kind: "included-plan" | "included-plan-or-extra-usage";
  label: string;
}

export interface SubscriptionLoginCommand {
  mode: "browser" | "device";
  command: string;
}

export interface SubscriptionCodingAdapterDescriptor {
  id: SubscriptionCodingAdapterId;
  label: string;
  binary: string;
  commandSetting: string;
  homeEnvironmentKey: "KIMI_CODE_HOME" | "GROK_HOME";
  defaultAcpCommand: string;
  supportedPlatforms: readonly NodeJS.Platform[];
  billingSource: SubscriptionBillingSource;
  loginCommands: readonly SubscriptionLoginCommand[];
  statusCommand?: string;
  logoutCommand?: string;
  logoutInstructions: string;
  docsUrl: string;
  conflictingApiEnvironmentKeys: readonly string[];
  requiresUserAttended: boolean;
}

const SUPPORTED_DESKTOP_PLATFORMS: readonly NodeJS.Platform[] = [
  "darwin",
  "linux",
  "win32",
];

export const SUBSCRIPTION_CODING_ADAPTERS: Readonly<
  Record<SubscriptionCodingAdapterId, SubscriptionCodingAdapterDescriptor>
> = {
  kimi: {
    id: "kimi",
    label: "Kimi Code",
    binary: "kimi",
    commandSetting: "ELIZA_KIMI_ACP_COMMAND",
    homeEnvironmentKey: "KIMI_CODE_HOME",
    defaultAcpCommand: "kimi acp",
    supportedPlatforms: SUPPORTED_DESKTOP_PLATFORMS,
    billingSource: {
      kind: "included-plan-or-extra-usage",
      label: "Kimi Code allowance or opted-in Extra Usage",
    },
    loginCommands: [{ mode: "device", command: "kimi" }],
    logoutInstructions:
      "Open Kimi Code interactively and enter /logout; the CLI has no top-level logout command.",
    docsUrl: "https://github.com/MoonshotAI/kimi-code",
    conflictingApiEnvironmentKeys: [
      "KIMI_API_KEY",
      "KIMI_CODING_API_KEY",
      "MOONSHOT_API_KEY",
      "KIMI_BASE_URL",
      "KIMI_CODING_BASE_URL",
      "MOONSHOT_BASE_URL",
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_MODEL",
      "ELIZA_KIMI_API_KEY",
      "ELIZA_KIMI_CODING_API_KEY",
      "ELIZA_MOONSHOT_API_KEY",
      "KIMI_CODE_BASE_URL",
      "KIMI_CODE_OAUTH_HOST",
      "KIMI_OAUTH_HOST",
      "KIMI_CODE_CUSTOM_HEADERS",
      "KIMI_WEB_SEARCH_API_KEY",
      "KIMI_WEB_SEARCH_BASE_URL",
      "KIMI_WEB_FETCH_API_KEY",
      "KIMI_WEB_FETCH_BASE_URL",
    ],
    requiresUserAttended: true,
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    binary: "grok",
    commandSetting: "ELIZA_GROK_ACP_COMMAND",
    homeEnvironmentKey: "GROK_HOME",
    defaultAcpCommand: "grok agent stdio",
    supportedPlatforms: SUPPORTED_DESKTOP_PLATFORMS,
    billingSource: {
      kind: "included-plan",
      label: "Grok included plan",
    },
    loginCommands: [
      { mode: "browser", command: "grok login" },
      { mode: "device", command: "grok login --device-auth" },
    ],
    statusCommand: "grok models",
    logoutCommand: "grok logout",
    logoutInstructions: "Run grok logout.",
    docsUrl: "https://github.com/xai-org/grok-build",
    conflictingApiEnvironmentKeys: [
      "XAI_API_KEY",
      "GROK_API_KEY",
      "XAI_BASE_URL",
      "GROK_MODELS_BASE_URL",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "OPENAI_MODEL",
      "ELIZA_XAI_API_KEY",
      "ELIZA_GROK_API_KEY",
      "GROK_AUTH",
      "GROK_AUTH_PATH",
      "GROK_AUTH_PROVIDER_COMMAND",
      "GROK_AUTH_PROVIDER_LABEL",
      "GROK_OIDC_ISSUER",
      "GROK_OIDC_CLIENT_ID",
      "GROK_OIDC_SCOPES",
      "GROK_OIDC_AUDIENCE",
      "GROK_OAUTH2_ISSUER",
      "GROK_OAUTH2_CLIENT_ID",
      "GROK_OAUTH2_SCOPES",
      "GROK_OAUTH2_PRINCIPAL_TYPE",
      "GROK_OAUTH2_PRINCIPAL_ID",
      "GROK_OAUTH2_REFERRER",
      "GROK_LOCAL_AUTH",
    ],
    requiresUserAttended: false,
  },
};

export type SubscriptionAdapterProbeStatus =
  | "ready"
  | "runtime-missing"
  | "platform-unsupported"
  | "auth-required"
  | "auth-expired"
  | "billing-conflict"
  | "execution-policy-blocked"
  | "transport-unsupported";

export interface SubscriptionCodingAdapterProbe {
  adapterId: SubscriptionCodingAdapterId;
  status: SubscriptionAdapterProbeStatus;
  installed: boolean;
  authenticated: boolean;
  spawnable: boolean;
  command: string;
  detail: string;
  billingSource: SubscriptionBillingSource;
}

export type SubscriptionCodingAdapterErrorCode =
  | "CODING_SUBSCRIPTION_RUNTIME_MISSING"
  | "CODING_SUBSCRIPTION_PLATFORM_UNSUPPORTED"
  | "CODING_SUBSCRIPTION_AUTH_REQUIRED"
  | "CODING_SUBSCRIPTION_AUTH_EXPIRED"
  | "CODING_SUBSCRIPTION_BILLING_CONFLICT"
  | "CODING_SUBSCRIPTION_EXECUTION_POLICY_BLOCKED"
  | "CODING_SUBSCRIPTION_TRANSPORT_UNSUPPORTED"
  | "CODING_SUBSCRIPTION_LOGIN_REVOKED"
  | "CODING_SUBSCRIPTION_QUOTA_EXHAUSTED";

export class SubscriptionCodingAdapterError extends ElizaError {
  override readonly name = "SubscriptionCodingAdapterError";
  readonly adapterId: SubscriptionCodingAdapterId;

  constructor(
    adapterId: SubscriptionCodingAdapterId,
    message: string,
    options: {
      code: SubscriptionCodingAdapterErrorCode;
      cause?: unknown;
      context?: Record<string, unknown>;
    },
  ) {
    super(message, {
      code: options.code,
      cause: options.cause,
      context: { adapterId, ...options.context },
    });
    this.adapterId = adapterId;
  }
}

export interface SubscriptionCodingAdapterProbeOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  executionMode?: SubscriptionExecutionMode;
  homeDir?: string;
  nowMs?: number;
  platform?: NodeJS.Platform;
  transportMode?: "native" | "cli";
}

interface LocalAuthProbe {
  status: "authenticated" | "required" | "expired" | "billing-conflict";
  detail: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;
const GROK_EARLY_INVALIDATION_MS = 5 * 60 * 1_000;
const GROK_DEFAULT_AUTH_SCOPE =
  "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const GROK_LEGACY_AUTH_SCOPE = "https://accounts.x.ai/sign-in";
const MAX_LOCAL_CONFIG_BYTES = 1024 * 1024;
const KIMI_MANAGED_PROVIDER = "managed:kimi-code";
const KIMI_MANAGED_OAUTH_KEY = "oauth/kimi-code";
const KIMI_INCLUDED_PLAN_BASE_URL = "https://api.kimi.com/coding/v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // error-policy:J3 credential state is untrusted local input; absent or
    // malformed JSON becomes an explicit auth-required probe, never a healthy
    // default and never leaks credential material into the diagnostic.
    return undefined;
  }
}

function readTomlRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    if (statSync(filePath).size > MAX_LOCAL_CONFIG_BYTES) return undefined;
    const parsed: unknown = parseToml(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // error-policy:J3 CLI configuration is untrusted local input. A missing,
    // oversized, or malformed file is an explicit unusable-login result.
    return undefined;
  }
}

function recordString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return nonEmptyString(record[key]);
}

function hasNonEmptyRecordValue(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return Object.values(value).some((candidate) => {
    if (typeof candidate === "string") return Boolean(candidate.trim());
    return candidate !== undefined && candidate !== null;
  });
}

function normalizedEndpoint(value: string | undefined): string | undefined {
  return value?.replace(/\/+$/u, "");
}

function probeKimiManagedConfiguration(
  root: string,
):
  | { status: "managed"; credentialKey: string }
  | { status: "required" | "billing-conflict"; detail: string } {
  const config = readTomlRecord(join(root, "config.toml"));
  if (!config) {
    return {
      status: "required",
      detail:
        "Kimi Code config.toml is missing or invalid; launch kimi and enter /login again.",
    };
  }
  const defaultModel = recordString(config, "default_model");
  const models = config.models;
  const model =
    defaultModel && isRecord(models) ? models[defaultModel] : undefined;
  const providerName = isRecord(model)
    ? recordString(model, "provider")
    : undefined;
  const providers = config.providers;
  const provider =
    providerName && isRecord(providers) ? providers[providerName] : undefined;
  if (!defaultModel || !providerName || !isRecord(provider)) {
    return {
      status: "required",
      detail:
        "Kimi Code has no complete default model/provider selection; launch kimi and enter /login again.",
    };
  }
  const oauth = provider.oauth;
  const credentialKey = isRecord(oauth)
    ? recordString(oauth, "key")
    : undefined;
  const oauthStorage = isRecord(oauth)
    ? recordString(oauth, "storage")
    : undefined;
  const directApiConfigured =
    Boolean(recordString(provider, "api_key")) ||
    hasNonEmptyRecordValue(provider.env) ||
    hasNonEmptyRecordValue(provider.custom_headers) ||
    normalizedEndpoint(recordString(provider, "base_url")) !==
      KIMI_INCLUDED_PLAN_BASE_URL;
  const managedOAuthSelected =
    providerName === KIMI_MANAGED_PROVIDER &&
    recordString(provider, "type") === "kimi" &&
    oauthStorage === "file" &&
    credentialKey === KIMI_MANAGED_OAUTH_KEY;
  if (directApiConfigured || !managedOAuthSelected || !credentialKey) {
    return {
      status: "billing-conflict",
      detail:
        "Kimi Code's selected default model is not pinned to the managed OAuth provider; select the Kimi Code login model before spawning.",
    };
  }
  return { status: "managed", credentialKey };
}

function probeKimiAuth(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  nowMs: number,
): LocalAuthProbe {
  const root =
    nonEmptyString(env.KIMI_CODE_HOME) ?? join(homeDir, ".kimi-code");
  const managed = probeKimiManagedConfiguration(root);
  if (managed.status !== "managed") return managed;
  const credentialName = managed.credentialKey.slice("oauth/".length);
  const credentials = readJsonRecord(
    join(root, "credentials", `${credentialName}.json`),
  );
  const accessToken = nonEmptyString(credentials?.access_token);
  const refreshToken = nonEmptyString(credentials?.refresh_token);
  if (!accessToken && !refreshToken) {
    return {
      status: "required",
      detail: "Launch kimi and enter /login.",
    };
  }
  const expiresAt = credentials?.expires_at;
  const expiresAtMs =
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt * 1_000
      : undefined;
  if (expiresAtMs !== undefined && expiresAtMs <= nowMs && !refreshToken) {
    return {
      status: "expired",
      detail:
        "The local Kimi Code login expired; launch kimi and enter /login again.",
    };
  }
  return {
    status: "authenticated",
    detail:
      "Kimi Code OAuth state is present; ACP verifies it during session creation.",
  };
}

function isGrokAuthRecord(value: unknown): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.key) ||
    typeof value.user_id !== "string" ||
    !nonEmptyString(value.create_time) ||
    !Number.isFinite(Date.parse(String(value.create_time)))
  ) {
    return false;
  }
  const mode = nonEmptyString(value.auth_mode)?.toLowerCase();
  if (
    !mode ||
    !["oidc", "web_login", "grok", "external", "api_key"].includes(mode)
  ) {
    return false;
  }
  const expiresAt = value.expires_at;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt)))
  ) {
    return false;
  }
  return (
    value.refresh_token === undefined || typeof value.refresh_token === "string"
  );
}

function isGrokSubscriptionAuth(
  value: unknown,
): value is Record<string, unknown> {
  return (
    isGrokAuthRecord(value) &&
    nonEmptyString(value.auth_mode)?.toLowerCase() === "oidc"
  );
}

function grokEntryExpired(
  entry: Record<string, unknown>,
  nowMs: number,
): boolean {
  if (nonEmptyString(entry.refresh_token)) return false;
  const expiresAt = nonEmptyString(entry.expires_at);
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    return (
      Number.isFinite(parsed) && parsed - GROK_EARLY_INVALIDATION_MS <= nowMs
    );
  }
  const createdAt = nonEmptyString(entry.create_time);
  if (!createdAt) return false;
  const parsed = Date.parse(createdAt);
  return (
    Number.isFinite(parsed) &&
    parsed + THIRTY_DAYS_MS - GROK_EARLY_INVALIDATION_MS <= nowMs
  );
}

function probeGrokAuth(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  nowMs: number,
): LocalAuthProbe {
  const root = nonEmptyString(env.GROK_HOME) ?? join(homeDir, ".grok");
  const authMap = readJsonRecord(join(root, "auth.json"));
  if (!authMap) {
    return {
      status: "required",
      detail: "Run grok login or grok login --device-auth.",
    };
  }
  if (Object.values(authMap).some((entry) => !isGrokAuthRecord(entry))) {
    return {
      status: "required",
      detail:
        "Grok auth.json contains an invalid credential record; run grok login again.",
    };
  }
  const selected =
    authMap[GROK_DEFAULT_AUTH_SCOPE] ?? authMap[GROK_LEGACY_AUTH_SCOPE];
  if (!isGrokSubscriptionAuth(selected)) {
    return {
      status: "required",
      detail:
        "The selected Grok OAuth record is missing, legacy, or invalid; run grok login again.",
    };
  }
  if (grokEntryExpired(selected, nowMs)) {
    return {
      status: "expired",
      detail: "The local Grok login expired; run grok login again.",
    };
  }
  return {
    status: "authenticated",
    detail:
      "Grok OAuth state is present; ACP verifies it during session creation.",
  };
}

function isExecutableFile(candidate: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    // error-policy:J3 command-path probe; missing, inaccessible, or
    // non-executable candidates are explicitly reported as runtime-missing.
    return false;
  }
}

function leadingCommandToken(command: string): string | undefined {
  const [token] = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/gu) ?? [];
  return token?.replace(/^(['"])(.*)\1$/u, "$2");
}

function hasExecutable(command: string, env: NodeJS.ProcessEnv): boolean {
  const executable = leadingCommandToken(command.trim());
  if (!executable) return false;
  if (isAbsolute(executable)) return isExecutableFile(executable);
  if (executable.includes("/") || executable.includes("\\")) {
    return isExecutableFile(resolve(executable));
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, executable);
    if (isExecutableFile(candidate)) return true;
    if ((env.PATHEXT ?? "") && process.platform === "win32") {
      for (const extension of (env.PATHEXT ?? ".EXE;.CMD;.BAT")
        .split(";")
        .filter(Boolean)) {
        if (isExecutableFile(`${candidate}${extension.toLowerCase()}`))
          return true;
        if (isExecutableFile(`${candidate}${extension.toUpperCase()}`))
          return true;
      }
    }
  }
  return false;
}

export function isSubscriptionCodingAdapter(
  value: string | undefined,
): value is SubscriptionCodingAdapterId {
  return SUBSCRIPTION_CODING_ADAPTER_IDS.includes(
    value as SubscriptionCodingAdapterId,
  );
}

export function subscriptionCodingAdapterCommand(
  adapterId: SubscriptionCodingAdapterId,
  configuredCommand?: string,
): string {
  return (
    nonEmptyString(configuredCommand) ??
    SUBSCRIPTION_CODING_ADAPTERS[adapterId].defaultAcpCommand
  );
}

export function probeSubscriptionCodingAdapter(
  adapterId: SubscriptionCodingAdapterId,
  options: SubscriptionCodingAdapterProbeOptions = {},
): SubscriptionCodingAdapterProbe {
  const descriptor = SUBSCRIPTION_CODING_ADAPTERS[adapterId];
  const env = options.env ?? process.env;
  const command = subscriptionCodingAdapterCommand(adapterId, options.command);
  const base = {
    adapterId,
    command,
    billingSource: descriptor.billingSource,
  };
  if (options.transportMode && options.transportMode !== "native") {
    return {
      ...base,
      status: "transport-unsupported",
      installed: false,
      authenticated: false,
      spawnable: false,
      detail: `${descriptor.label} subscription mode requires the native ACP transport.`,
    };
  }
  const platform = options.platform ?? process.platform;
  if (!descriptor.supportedPlatforms.includes(platform)) {
    return {
      ...base,
      status: "platform-unsupported",
      installed: false,
      authenticated: false,
      spawnable: false,
      detail: `${descriptor.label} is not supported on ${platform}.`,
    };
  }
  if (
    descriptor.requiresUserAttended &&
    options.executionMode === "unattended"
  ) {
    return {
      ...base,
      status: "execution-policy-blocked",
      installed: false,
      authenticated: false,
      spawnable: false,
      detail: `${descriptor.label} subscription sessions must be user-attended.`,
    };
  }
  if (!hasExecutable(command, env)) {
    return {
      ...base,
      status: "runtime-missing",
      installed: false,
      authenticated: false,
      spawnable: false,
      detail: `${descriptor.label} is not installed or is not executable on PATH.`,
    };
  }
  const auth =
    adapterId === "kimi"
      ? probeKimiAuth(
          env,
          options.homeDir ?? homedir(),
          options.nowMs ?? Date.now(),
        )
      : probeGrokAuth(
          env,
          options.homeDir ?? homedir(),
          options.nowMs ?? Date.now(),
        );
  if (auth.status !== "authenticated") {
    return {
      ...base,
      status:
        auth.status === "expired"
          ? "auth-expired"
          : auth.status === "billing-conflict"
            ? "billing-conflict"
            : "auth-required",
      installed: true,
      authenticated: false,
      spawnable: false,
      detail: auth.detail,
    };
  }
  return {
    ...base,
    status: "ready",
    installed: true,
    authenticated: true,
    spawnable: true,
    detail: auth.detail,
  };
}

function probeErrorCode(
  status: Exclude<SubscriptionAdapterProbeStatus, "ready">,
): SubscriptionCodingAdapterErrorCode {
  switch (status) {
    case "runtime-missing":
      return "CODING_SUBSCRIPTION_RUNTIME_MISSING";
    case "platform-unsupported":
      return "CODING_SUBSCRIPTION_PLATFORM_UNSUPPORTED";
    case "auth-required":
      return "CODING_SUBSCRIPTION_AUTH_REQUIRED";
    case "auth-expired":
      return "CODING_SUBSCRIPTION_AUTH_EXPIRED";
    case "billing-conflict":
      return "CODING_SUBSCRIPTION_BILLING_CONFLICT";
    case "execution-policy-blocked":
      return "CODING_SUBSCRIPTION_EXECUTION_POLICY_BLOCKED";
    case "transport-unsupported":
      return "CODING_SUBSCRIPTION_TRANSPORT_UNSUPPORTED";
  }
}

export function assertSubscriptionCodingAdapterReady(
  adapterId: SubscriptionCodingAdapterId,
  options: SubscriptionCodingAdapterProbeOptions = {},
): SubscriptionCodingAdapterProbe {
  const descriptor = SUBSCRIPTION_CODING_ADAPTERS[adapterId];
  if (
    descriptor.requiresUserAttended &&
    options.executionMode !== "user-attended"
  ) {
    throw new SubscriptionCodingAdapterError(
      adapterId,
      `${descriptor.label} subscription sessions require an explicit user-attended execution mode; scheduled and unattended spawns are disabled.`,
      {
        code: "CODING_SUBSCRIPTION_EXECUTION_POLICY_BLOCKED",
        context: {
          requiredExecutionMode: "user-attended",
          configuredExecutionMode: options.executionMode ?? "unspecified",
        },
      },
    );
  }
  const probe = probeSubscriptionCodingAdapter(adapterId, options);
  if (probe.status === "ready") return probe;
  throw new SubscriptionCodingAdapterError(adapterId, probe.detail, {
    code: probeErrorCode(probe.status),
    context: { status: probe.status, command: probe.command },
  });
}

export function stripSubscriptionApiEnvironment(
  adapterId: SubscriptionCodingAdapterId,
  env: NodeJS.ProcessEnv,
): string[] {
  const removed: string[] = [];
  for (const key of SUBSCRIPTION_CODING_ADAPTERS[adapterId]
    .conflictingApiEnvironmentKeys) {
    if (env[key] === undefined) continue;
    delete env[key];
    removed.push(key);
  }
  for (const key of Object.keys(env)) {
    if (adapterId === "kimi" && key.startsWith("KIMI_MODEL_")) {
      delete env[key];
      removed.push(key);
      continue;
    }
    if (!key.startsWith("ELIZA_MODEL_GATEWAY_")) continue;
    delete env[key];
    removed.push(key);
  }
  return removed;
}

export function classifySubscriptionRuntimeFailure(
  adapterId: SubscriptionCodingAdapterId,
  failure: unknown,
): SubscriptionCodingAdapterError | undefined {
  const message = failure instanceof Error ? failure.message : String(failure);
  const descriptor = SUBSCRIPTION_CODING_ADAPTERS[adapterId];
  if (/quota|usage limit|rate limit|too many requests|\b429\b/i.test(message)) {
    return new SubscriptionCodingAdapterError(
      adapterId,
      `${descriptor.label} rejected the ACP session because coding allowance is unavailable. Check plan and optional extra-usage settings before retrying.`,
      {
        code: "CODING_SUBSCRIPTION_QUOTA_EXHAUSTED",
        cause: failure,
      },
    );
  }
  if (
    /revoked|unauthorized|authenticate|login required|token expired|invalid_grant|\b401\b/i.test(
      message,
    )
  ) {
    return new SubscriptionCodingAdapterError(
      adapterId,
      `${descriptor.label} rejected the saved login. Sign in again before retrying.`,
      {
        code: "CODING_SUBSCRIPTION_LOGIN_REVOKED",
        cause: failure,
      },
    );
  }
  return undefined;
}
