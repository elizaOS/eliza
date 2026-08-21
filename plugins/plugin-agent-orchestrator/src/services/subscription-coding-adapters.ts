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
import type { SubscriptionExecutionMode } from "./types.js";

export const SUBSCRIPTION_CODING_ADAPTER_IDS = ["kimi", "grok"] as const;

export type SubscriptionCodingAdapterId =
  (typeof SUBSCRIPTION_CODING_ADAPTER_IDS)[number];

export type { SubscriptionExecutionMode } from "./types.js";

export interface SubscriptionBillingSource {
  kind: "included-plan";
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
    defaultAcpCommand: "kimi acp",
    supportedPlatforms: SUPPORTED_DESKTOP_PLATFORMS,
    billingSource: {
      kind: "included-plan",
      label: "Kimi Code included plan",
    },
    loginCommands: [{ mode: "device", command: "kimi login" }],
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
    ],
    requiresUserAttended: true,
  },
  grok: {
    id: "grok",
    label: "Grok Build",
    binary: "grok",
    commandSetting: "ELIZA_GROK_ACP_COMMAND",
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
  status: "authenticated" | "required" | "expired";
  detail: string;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1_000;

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

function probeKimiAuth(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  nowMs: number,
): LocalAuthProbe {
  const root =
    nonEmptyString(env.KIMI_CODE_HOME) ?? join(homeDir, ".kimi-code");
  const credentials = readJsonRecord(
    join(root, "credentials", "kimi-code.json"),
  );
  const accessToken = nonEmptyString(credentials?.access_token);
  const refreshToken = nonEmptyString(credentials?.refresh_token);
  if (!accessToken && !refreshToken) {
    return { status: "required", detail: "Run kimi login." };
  }
  const expiresAt = credentials?.expires_at;
  const expiresAtMs =
    typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt * 1_000
      : undefined;
  if (expiresAtMs !== undefined && expiresAtMs <= nowMs && !refreshToken) {
    return {
      status: "expired",
      detail: "The local Kimi Code login expired; run kimi login again.",
    };
  }
  return {
    status: "authenticated",
    detail:
      "Kimi Code OAuth state is present; ACP verifies it during session creation.",
  };
}

function isGrokSubscriptionAuth(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecord(value) || !nonEmptyString(value.key)) return false;
  const mode = nonEmptyString(value.auth_mode)?.toLowerCase();
  return mode === "oidc" || mode === "web_login" || mode === "grok";
}

function grokEntryExpired(
  entry: Record<string, unknown>,
  nowMs: number,
): boolean {
  if (nonEmptyString(entry.refresh_token)) return false;
  const expiresAt = nonEmptyString(entry.expires_at);
  if (expiresAt) {
    const parsed = Date.parse(expiresAt);
    return Number.isFinite(parsed) && parsed <= nowMs;
  }
  const createdAt = nonEmptyString(entry.create_time);
  if (!createdAt) return false;
  const parsed = Date.parse(createdAt);
  return Number.isFinite(parsed) && parsed + THIRTY_DAYS_MS <= nowMs;
}

function probeGrokAuth(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  nowMs: number,
): LocalAuthProbe {
  const root = nonEmptyString(env.GROK_HOME) ?? join(homeDir, ".grok");
  const authMap = readJsonRecord(join(root, "auth.json"));
  const sessions = Object.values(authMap ?? {}).filter(isGrokSubscriptionAuth);
  if (sessions.length === 0) {
    return {
      status: "required",
      detail: "Run grok login or grok login --device-auth.",
    };
  }
  if (sessions.every((entry) => grokEntryExpired(entry, nowMs))) {
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
      status: auth.status === "expired" ? "auth-expired" : "auth-required",
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
      `${descriptor.label} rejected the ACP session because the included-plan quota is unavailable. Check plan usage before retrying.`,
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
