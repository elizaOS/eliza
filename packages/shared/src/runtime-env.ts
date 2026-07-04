/**
 * Resolves runtime ports and API security config from environment variables
 * (`ELIZA_PORT`, `ELIZA_API_PORT`, `ELIZA_API_BIND`, `ELIZA_API_TOKEN`,
 * `ELIZA_ALLOWED_ORIGINS`/`_HOSTS`, …). The single place server boot derives its
 * bind host, ports, and CORS/auth posture, so bind-mode classification
 * (loopback vs wildcard) and dev's API/UI port split live here.
 */

import { getBootConfig } from "./config/boot-config.js";
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
export const API_EXPOSE_PORT_KEYS = ["ELIZA_API_EXPOSE_PORT"] as const;
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
    const entry = resolveEnvEntry(env, key);
    if (entry) return entry.value;
  }
  return null;
}

/** First key in `keys` with a non-empty trimmed string value. */
export function firstWinningEnvString(
  env: RuntimeEnvRecord,
  keys: readonly string[],
): { key: string; value: string } | null {
  for (const key of keys) {
    const entry = resolveEnvEntry(env, key);
    if (entry) return entry;
  }
  return null;
}

function presentEnvValue(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function resolveEnvEntry(
  env: RuntimeEnvRecord,
  key: string,
): { key: string; value: string } | null {
  const direct = presentEnvValue(env[key]);
  if (direct !== undefined) return { key, value: direct };

  for (const [brandKey, elizaKey] of getBootConfig().envAliases ?? []) {
    const partner =
      key === brandKey ? elizaKey : key === elizaKey ? brandKey : null;
    if (!partner) continue;
    const value = presentEnvValue(env[partner]);
    if (value !== undefined) return { key: partner, value };
  }
  return null;
}

function resolveEnvValue(
  env: RuntimeEnvRecord,
  key: string,
): string | undefined {
  return resolveEnvEntry(env, key)?.value;
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
    const entry = resolveEnvEntry(env, key);
    if (!entry) continue;
    const p = parsePositivePort(entry.value);
    if (p !== null) {
      return {
        port: p,
        sourceLabel: `env set — ${entry.key}=${p}`,
        changeLabel: `unset ${entry.key} or set ELIZA_API_PORT / ELIZA_PORT (first wins); built-in ${DEFAULT_DESKTOP_API_PORT}`,
        winningKey: entry.key,
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
    const entry = resolveEnvEntry(env, key);
    if (!entry) continue;
    const p = parsePositivePort(entry.value);
    if (p !== null) {
      return {
        port: p,
        sourceLabel: `env set — ${entry.key}=${p}`,
        changeLabel: `unset ${entry.key} for built-in ${DEFAULT_DESKTOP_UI_PORT}`,
        winningKey: entry.key,
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
  if (!LOOPBACK_BIND_RE.test(normalized)) return false;
  const ipv4 = normalized.startsWith("::ffff:")
    ? normalized.slice("::ffff:".length)
    : normalized;
  if (/^127(?:\.\d{1,3}){3}$/.test(ipv4)) {
    return ipv4
      .split(".")
      .every(
        (octet) => Number.isInteger(Number(octet)) && Number(octet) <= 255,
      );
  }
  return true;
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
      parsePositivePort(resolveEnvValue(env, "ELIZA_PORT")) ??
      parsePositivePort(resolveEnvValue(env, "ELIZA_UI_PORT")) ??
      DEFAULT_SERVER_ONLY_PORT,
    desktopApiPort:
      parsePositivePort(resolveEnvValue(env, "ELIZA_API_PORT")) ??
      parsePositivePort(resolveEnvValue(env, "ELIZA_PORT")) ??
      DEFAULT_DESKTOP_API_PORT,
    desktopUiPort:
      parsePositivePort(resolveEnvValue(env, "ELIZA_UI_PORT")) ??
      DEFAULT_DESKTOP_UI_PORT,
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

/**
 * Whether the local agent should bind a TCP listener despite running in a
 * port-free local mode. Off by default: local-agent traffic flows over native
 * IPC (Capacitor / Electrobun RPC / stdio bridge). Set `ELIZA_API_EXPOSE_PORT`
 * truthy to re-open the HTTP listener for dev tooling, LAN access, or e2e
 * harnesses. Cloud/external/server-only modes never consult this flag.
 */
export function resolveApiExposePort(
  env: RuntimeEnvRecord = process.env,
): boolean {
  return parseEnabledFlag(env, API_EXPOSE_PORT_KEYS);
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
 * relies on (spawning subprocesses for signal-cli / sandbox engines,
 * `/usr/bin/open`, AppleScript, lsof, ffmpeg, etc.) either don't exist or
 * aren't reachable from the app sandbox. Code that would shell out should call
 * {@link isMobilePlatform} and return a logged mobile-unavailable status instead
 * of throwing — the mobile-unavailable behaviour described in
 * `docs/agent-on-mobile.md`.
 */
const MOBILE_PLATFORM_VALUES = new Set(["android", "ios"]);

export function isMobilePlatform(env: RuntimeEnvRecord = process.env): boolean {
  const raw = resolveEnvValue(env, "ELIZA_PLATFORM")?.trim().toLowerCase();
  if (!raw) return false;
  return MOBILE_PLATFORM_VALUES.has(raw);
}

export function isAndroidMobile(env: RuntimeEnvRecord = process.env): boolean {
  return (
    resolveEnvValue(env, "ELIZA_PLATFORM")?.trim().toLowerCase() === "android"
  );
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
