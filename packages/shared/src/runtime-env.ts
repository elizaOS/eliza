import { isTruthyEnvValue } from "./env-utils.js";

const DEFAULT_API_BIND_HOST = "127.0.0.1";
export const DEFAULT_SERVER_ONLY_PORT = 2138;
// Dev mode splits the API from the Vite UI: API on 31337, UI on 2138.
export const DEFAULT_DESKTOP_API_PORT = 31337;
export const DEFAULT_DESKTOP_UI_PORT = 2138;

const LOOPBACK_BIND_RE =
  /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\]|0:0:0:0:0:0:0:1|::ffff:127(?:\.\d{1,3}){3})$/i;
const WILDCARD_BIND_RE = /^(0\.0\.0\.0|::|0:0:0:0:0:0:0:0)$/i;

const API_BIND_KEYS = ["ELIZA_API_BIND"] as const;
const API_TOKEN_KEYS = ["ELIZA_API_TOKEN"] as const;
const API_ALLOWED_ORIGINS_KEYS = [
  "ELIZA_ALLOWED_ORIGINS",
  "CORS_ORIGINS",
] as const;
const API_ALLOWED_HOSTS_KEYS = ["ELIZA_ALLOWED_HOSTS"] as const;
const API_ALLOW_NULL_ORIGIN_KEYS = ["ELIZA_ALLOW_NULL_ORIGIN"] as const;
const DISABLE_AUTO_API_TOKEN_KEYS = ["ELIZA_DISABLE_AUTO_API_TOKEN"] as const;
const DESKTOP_API_PORT_KEYS = ["ELIZA_API_PORT", "ELIZA_PORT"] as const;
const DESKTOP_UI_PORT_KEYS = ["ELIZA_UI_PORT"] as const;
const SINGLE_PROCESS_PORT_KEYS = ["ELIZA_PORT", "ELIZA_UI_PORT"] as const;

export type RuntimeEnvRecord = Record<string, string | undefined>;

export interface ResolvedRuntimePorts {
  serverOnlyPort: number;
  desktopApiPort: number;
  desktopUiPort: number;
}

export interface ResolvedApiSecurityConfig {
  bindHost: string;
  token: string | null;
  disableAutoApiToken: boolean;
  allowedOrigins: string[];
  allowedHosts: string[];
  allowNullOrigin: boolean;
  isLoopbackBind: boolean;
  isWildcardBind: boolean;
}

export interface ElizaRuntimeEnv {
  apiBind: string;
  apiToken: string | undefined;
  allowedOrigins: string[];
  allowedHosts: string[];
  allowNullOrigin: boolean;
  disableAutoApiToken: boolean;
  desktopApiPort: number;
  singleProcessPort: number;
  uiPort: number;
}

export const ELIZA_RUNTIME_ENV_KEYS = {
  apiBind: API_BIND_KEYS,
  apiToken: API_TOKEN_KEYS,
  allowedOrigins: API_ALLOWED_ORIGINS_KEYS,
  allowedHosts: API_ALLOWED_HOSTS_KEYS,
  allowNullOrigin: API_ALLOW_NULL_ORIGIN_KEYS,
  disableAutoApiToken: DISABLE_AUTO_API_TOKEN_KEYS,
  desktopApiPort: DESKTOP_API_PORT_KEYS,
  singleProcessPort: SINGLE_PROCESS_PORT_KEYS,
  desktopUiPort: DESKTOP_UI_PORT_KEYS,
} as const;

function firstNonEmpty(
  env: RuntimeEnvRecord,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

/** First key in `keys` with a non-empty trimmed string value. */
export function firstWinningEnvString(
  env: RuntimeEnvRecord,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const value = env[key]?.trim();
    if (value) return { key, value };
  }
  return null;
}

export interface PortPreferenceResolution {
  port: number;
  sourceLabel: string;
  changeLabel: string;
  winningKey: string | null;
}

/** Preferred desktop API port from env precedence (before loopback reallocation). */
export function resolveDesktopApiPortPreference(
  env: RuntimeEnvRecord = process.env,
): PortPreferenceResolution {
  for (const key of DESKTOP_API_PORT_KEYS) {
    const p = parsePositivePort(env[key]);
    if (p !== null) {
      return {
        port: p,
        sourceLabel: `env set — ${key}=${p}`,
        changeLabel: `unset ${key} or set ELIZA_API_PORT / ELIZA_PORT (first wins); built-in ${DEFAULT_DESKTOP_API_PORT}`,
        winningKey: key,
      };
    }
  }
  return {
    port: DEFAULT_DESKTOP_API_PORT,
    sourceLabel: `default (unset — built-in ${DEFAULT_DESKTOP_API_PORT})`,
    changeLabel:
      "export ELIZA_API_PORT=<port> (or ELIZA_PORT; first non-empty wins)",
    winningKey: null,
  };
}

/** Preferred dashboard UI port from ELIZA_UI_PORT (Vite dev), before reallocation. */
export function resolveDesktopUiPortPreference(
  env: RuntimeEnvRecord = process.env,
): PortPreferenceResolution {
  for (const key of DESKTOP_UI_PORT_KEYS) {
    const p = parsePositivePort(env[key]);
    if (p !== null) {
      return {
        port: p,
        sourceLabel: `env set — ${key}=${p}`,
        changeLabel: `unset ${key} for built-in ${DEFAULT_DESKTOP_UI_PORT}`,
        winningKey: key,
      };
    }
  }
  return {
    port: DEFAULT_DESKTOP_UI_PORT,
    sourceLabel: `default (unset — built-in ${DEFAULT_DESKTOP_UI_PORT})`,
    changeLabel: "export ELIZA_UI_PORT=<port>",
    winningKey: null,
  };
}

function parsePositivePort(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 && parsed < 65536
    ? parsed
    : null;
}

function parseCsv(env: RuntimeEnvRecord, keys: readonly string[]): string[] {
  const raw = firstNonEmpty(env, keys);
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseEnabledFlag(
  env: RuntimeEnvRecord,
  keys: readonly string[],
): boolean {
  return isTruthyEnvValue(firstNonEmpty(env, keys) ?? undefined);
}

export function stripOptionalHostPort(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const lower = trimmed.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) {
    try {
      return new URL(lower).hostname.toLowerCase();
    } catch {
      return lower;
    }
  }

  if (lower.startsWith("[")) {
    const close = lower.indexOf("]");
    return close > 0 ? lower.slice(1, close) : lower.slice(1);
  }

  if ((lower.match(/:/g) || []).length >= 2) {
    return lower;
  }

  return lower.replace(/:\d+$/, "");
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = stripOptionalHostPort(host);
  if (!normalized) return true;
  if (LOOPBACK_BIND_RE.test(normalized)) return true;
  return normalized.startsWith("127.");
}

export function isWildcardBindHost(host: string): boolean {
  const normalized = stripOptionalHostPort(host);
  return WILDCARD_BIND_RE.test(normalized);
}

export function resolveRuntimePorts(
  env: RuntimeEnvRecord = process.env,
): ResolvedRuntimePorts {
  return {
    serverOnlyPort:
      parsePositivePort(env.ELIZA_PORT) ??
      parsePositivePort(env.ELIZA_UI_PORT) ??
      DEFAULT_SERVER_ONLY_PORT,
    desktopApiPort:
      parsePositivePort(env.ELIZA_API_PORT) ??
      parsePositivePort(env.ELIZA_PORT) ??
      DEFAULT_DESKTOP_API_PORT,
    desktopUiPort:
      parsePositivePort(env.ELIZA_UI_PORT) ?? DEFAULT_DESKTOP_UI_PORT,
  };
}

export function resolveServerOnlyPort(
  env: RuntimeEnvRecord = process.env,
): number {
  return resolveRuntimePorts(env).serverOnlyPort;
}

export function resolveDesktopApiPort(
  env: RuntimeEnvRecord = process.env,
): number {
  return resolveRuntimePorts(env).desktopApiPort;
}

export function resolveDesktopUiPort(
  env: RuntimeEnvRecord = process.env,
): number {
  return resolveRuntimePorts(env).desktopUiPort;
}

export function resolveSingleProcessPort(
  env: RuntimeEnvRecord = process.env,
): number {
  return resolveServerOnlyPort(env);
}

export function resolveUiPort(env: RuntimeEnvRecord = process.env): number {
  return resolveDesktopUiPort(env);
}

export function resolveApiSecurityConfig(
  env: RuntimeEnvRecord = process.env,
): ResolvedApiSecurityConfig {
  const bindHost = firstNonEmpty(env, API_BIND_KEYS) ?? DEFAULT_API_BIND_HOST;
  return {
    bindHost,
    token: firstNonEmpty(env, API_TOKEN_KEYS),
    disableAutoApiToken: parseEnabledFlag(env, DISABLE_AUTO_API_TOKEN_KEYS),
    allowedOrigins: parseCsv(env, API_ALLOWED_ORIGINS_KEYS),
    allowedHosts: parseCsv(env, API_ALLOWED_HOSTS_KEYS),
    allowNullOrigin: parseEnabledFlag(env, API_ALLOW_NULL_ORIGIN_KEYS),
    isLoopbackBind: isLoopbackBindHost(bindHost),
    isWildcardBind: isWildcardBindHost(bindHost),
  };
}

export function resolveApiBindHost(
  env: RuntimeEnvRecord = process.env,
): string {
  return resolveApiSecurityConfig(env).bindHost;
}

export function resolveApiToken(
  env: RuntimeEnvRecord = process.env,
): string | null {
  return resolveApiSecurityConfig(env).token;
}

export function resolveConfiguredApiToken(
  env: RuntimeEnvRecord = process.env,
): string | undefined {
  return resolveApiToken(env) ?? undefined;
}

export function resolveAllowedOrigins(
  env: RuntimeEnvRecord = process.env,
): string[] {
  return resolveApiSecurityConfig(env).allowedOrigins;
}

export function resolveApiAllowedOrigins(
  env: RuntimeEnvRecord = process.env,
): string[] {
  return resolveAllowedOrigins(env);
}

export function resolveAllowedHosts(
  env: RuntimeEnvRecord = process.env,
): string[] {
  return resolveApiSecurityConfig(env).allowedHosts;
}

export function resolveApiAllowedHosts(
  env: RuntimeEnvRecord = process.env,
): string[] {
  return resolveAllowedHosts(env);
}

export function isNullOriginAllowed(
  env: RuntimeEnvRecord = process.env,
): boolean {
  return resolveApiSecurityConfig(env).allowNullOrigin;
}

export function resolveAllowNullOrigin(
  env: RuntimeEnvRecord = process.env,
): boolean {
  return isNullOriginAllowed(env);
}

export function resolveDisableAutoApiToken(
  env: RuntimeEnvRecord = process.env,
): boolean {
  return resolveApiSecurityConfig(env).disableAutoApiToken;
}

export function setApiToken(
  env: RuntimeEnvRecord = process.env,
  token: string,
): void {
  env.ELIZA_API_TOKEN = token;
}

export function syncResolvedApiPort(
  env: RuntimeEnvRecord = process.env,
  actualPort: number,
  opts?: { overwriteUiPort?: boolean },
): void {
  const normalizedPort = String(actualPort);
  env.ELIZA_API_PORT = normalizedPort;
  if (opts?.overwriteUiPort) {
    env.ELIZA_UI_PORT = normalizedPort;
    env.ELIZA_PORT = normalizedPort;
    return;
  }

  if (!env.ELIZA_UI_PORT) {
    env.ELIZA_PORT = normalizedPort;
  }
}

/**
 * `ELIZA_PLATFORM` values that the agent runtime treats as a mobile (Android /
 * iOS) embedding. On these platforms many host capabilities the agent normally
 * relies on (spawning subprocesses for n8n / signal-cli / sandbox engines,
 * `/usr/bin/open`, AppleScript, lsof, ffmpeg, etc.) either don't exist or
 * aren't reachable from the app sandbox. Code that would shell out should call
 * {@link isMobilePlatform} and short-circuit to a logged no-op instead of
 * throwing — the "skipped on mobile" behaviour described in
 * `docs/agent-on-mobile.md`.
 */
const MOBILE_PLATFORM_VALUES = new Set(["android", "ios"]);

export function isMobilePlatform(env: RuntimeEnvRecord = process.env): boolean {
  const raw = env.ELIZA_PLATFORM?.trim().toLowerCase();
  if (!raw) return false;
  return MOBILE_PLATFORM_VALUES.has(raw);
}

export function isAndroidMobile(env: RuntimeEnvRecord = process.env): boolean {
  return env.ELIZA_PLATFORM?.trim().toLowerCase() === "android";
}

export function resolveElizaRuntimeEnv(
  env: RuntimeEnvRecord = process.env,
): ElizaRuntimeEnv {
  const ports = resolveRuntimePorts(env);
  const security = resolveApiSecurityConfig(env);
  return {
    apiBind: security.bindHost,
    apiToken: security.token ?? undefined,
    allowedOrigins: security.allowedOrigins,
    allowedHosts: security.allowedHosts,
    allowNullOrigin: security.allowNullOrigin,
    disableAutoApiToken: security.disableAutoApiToken,
    desktopApiPort: ports.desktopApiPort,
    singleProcessPort: ports.serverOnlyPort,
    uiPort: ports.desktopUiPort,
  };
}
