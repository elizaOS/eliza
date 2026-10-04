/**
 * Resolves the HTTP API server's environment configuration from a
 * `RuntimeEnvRecord` (defaulting to `process.env`): bind host, auth token,
 * allowed origins/hosts, null-origin policy, and the desktop / single-process /
 * UI port precedence. The API host and boot helpers read through these resolvers
 * rather than touching `process.env` directly, so one set of precedence and
 * alias rules (e.g. `ELIZA_API_PORT` then `ELIZA_PORT`) applies everywhere.
 *
 * Also classifies a bind host as loopback vs wildcard — the signal for whether
 * an auth token must be present before binding to a public interface — and
 * detects mobile (`ELIZA_PLATFORM=android|ios`) embeddings where host
 * capabilities that shell out are unavailable.
 */

import {
  isLoopbackBindHost,
  isTruthyEnvValue,
  isWildcardBindHost,
  stripOptionalHostPort,
} from "@elizaos/core/protocol";
import { getBootConfigEnvAliases } from "./config/boot-config-store.js";

const DEFAULT_API_BIND_HOST = "127.0.0.1";
export const DEFAULT_SERVER_ONLY_PORT = 2138;
// Dev mode splits the API from the Vite UI: API on 31337, UI on 2138.
export const DEFAULT_DESKTOP_API_PORT = 31337;
export const DEFAULT_DESKTOP_UI_PORT = 2138;

const API_BIND_KEYS = ["ELIZA_API_BIND"] as const;
const API_TOKEN_KEYS = ["ELIZA_API_TOKEN"] as const;
const LEGACY_SELF_API_TOKEN_KEYS = ["ELIZA_API_AUTH_TOKEN"] as const;
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

  const aliases = getBootConfigEnvAliases();
  if (!aliases) return null;

  for (const [brandKey, elizaKey] of aliases) {
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
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
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
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
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

export function resolveRuntimePorts(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
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
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): number {
  return resolveRuntimePorts(env).serverOnlyPort;
}

export function resolveDesktopApiPort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): number {
  return resolveRuntimePorts(env).desktopApiPort;
}

export function resolveDesktopUiPort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): number {
  return resolveRuntimePorts(env).desktopUiPort;
}

export function resolveSingleProcessPort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): number {
  return resolveServerOnlyPort(env);
}

export function resolveUiPort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): number {
  return resolveDesktopUiPort(env);
}

/** Removes an optional leading `Bearer ` so stored and sent forms compare equal. */
function stripBearerPrefix(value: string | null | undefined): string | null {
  if (value == null) return null;
  const stripped = value.replace(/^Bearer\s+/i, "").trim();
  return stripped || null;
}

export function resolveApiSecurityConfig(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): ResolvedApiSecurityConfig {
  const bindHost = firstNonEmpty(env, API_BIND_KEYS) ?? DEFAULT_API_BIND_HOST;
  return {
    bindHost,
    token: stripBearerPrefix(firstNonEmpty(env, API_TOKEN_KEYS)),
    disableAutoApiToken: parseEnabledFlag(env, DISABLE_AUTO_API_TOKEN_KEYS),
    allowedOrigins: parseCsv(env, API_ALLOWED_ORIGINS_KEYS),
    allowedHosts: parseCsv(env, API_ALLOWED_HOSTS_KEYS),
    allowNullOrigin: parseEnabledFlag(env, API_ALLOW_NULL_ORIGIN_KEYS),
    isLoopbackBind: isLoopbackBindHost(bindHost),
    isWildcardBind: isWildcardBindHost(bindHost),
  };
}

export function resolveApiBindHost(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string {
  return resolveApiSecurityConfig(env).bindHost;
}

export function resolveApiToken(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string | null {
  return resolveApiSecurityConfig(env).token;
}

/** Resolve the normalized credential used for same-process HTTP calls. */
export function resolveSelfApiCredential(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string | null {
  const token =
    firstWinningEnvString(env, API_TOKEN_KEYS)?.value ??
    firstWinningEnvString(env, LEGACY_SELF_API_TOKEN_KEYS)?.value;
  return stripBearerPrefix(token);
}

/** Build authorization headers for requests back to the local elizaOS API. */
export function createSelfApiRequestHeaders(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): Record<string, string> {
  const credential = resolveSelfApiCredential(env);
  return credential ? { Authorization: `Bearer ${credential}` } : {};
}

/**
 * Base URL (no trailing slash) for same-process HTTP calls back to this
 * elizaOS API. Uses the listener's exact port precedence: `ELIZA_API_PORT`
 * (desktop launcher, synced to the bound port by `syncResolvedApiPort`) wins,
 * otherwise the single-process port. Wildcard binds are reached via
 * `127.0.0.1`; every specific interface, including a loopback address,
 * is reached on that exact interface.
 */
export function resolveSelfApiBaseUrl(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string {
  const port = resolveEnvValue(env, "ELIZA_API_PORT")
    ? resolveDesktopApiPort(env)
    : resolveServerOnlyPort(env);
  const bindHost = stripOptionalHostPort(resolveApiBindHost(env));
  let host: string;
  if (!bindHost || isWildcardBindHost(bindHost)) {
    host = "127.0.0.1";
  } else {
    host = bindHost.includes(":") ? `[${bindHost}]` : bindHost;
  }
  return `http://${host}:${port}`;
}

/** Whether the API process is running under a development file watcher. */
export function isDevApiWatchEnabled(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
  execArgv: readonly string[] = globalThis.process?.execArgv ?? [],
): boolean {
  return (
    execArgv.includes("--watch") ||
    env.ELIZA_DESKTOP_API_WATCH === "1" ||
    env.ELIZA_DEV_SOURCE_WATCH === "1"
  );
}

export function resolveConfiguredApiToken(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string | undefined {
  return resolveApiToken(env) ?? undefined;
}

export function resolveAllowedOrigins(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string[] {
  return resolveApiSecurityConfig(env).allowedOrigins;
}

export function resolveApiAllowedOrigins(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string[] {
  return resolveAllowedOrigins(env);
}

export function resolveAllowedHosts(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string[] {
  return resolveApiSecurityConfig(env).allowedHosts;
}

export function resolveApiAllowedHosts(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string[] {
  return resolveAllowedHosts(env);
}

export function isNullOriginAllowed(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return resolveApiSecurityConfig(env).allowNullOrigin;
}

export function resolveAllowNullOrigin(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return isNullOriginAllowed(env);
}

export function resolveDisableAutoApiToken(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return resolveApiSecurityConfig(env).disableAutoApiToken;
}

/** Whether a local IPC runtime should also expose its HTTP listener. */
export function resolveApiExposePort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return parseEnabledFlag(env, API_EXPOSE_PORT_KEYS);
}

export function setApiToken(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
  token: string,
): void {
  env.ELIZA_API_TOKEN = token;
}

export function syncResolvedApiPort(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
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
 * relies on (spawning subprocesses for sandbox engines,
 * `/usr/bin/open`, AppleScript, lsof, ffmpeg, etc.) either don't exist or
 * aren't reachable from the app sandbox. Code that would shell out should call
 * {@link isMobilePlatform} and short-circuit with a skip log instead of
 * throwing — the "skipped on mobile" behaviour described in
 * `docs/agent-on-mobile.md`.
 */
const MOBILE_PLATFORM_VALUES = new Set(["android", "ios"]);

export function isMobilePlatform(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  const raw = resolvePlatform(env);
  if (!raw) return false;
  return MOBILE_PLATFORM_VALUES.has(raw);
}

export function isAndroidMobile(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return resolvePlatform(env) === "android";
}

export function isIosMobile(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): boolean {
  return resolvePlatform(env) === "ios";
}

/** Resolve the normalized platform through canonical and branded env aliases. */
export function resolvePlatform(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
): string | undefined {
  return resolveEnvValue(env, "ELIZA_PLATFORM")?.trim().toLowerCase();
}

export function resolveElizaRuntimeEnv(
  env: RuntimeEnvRecord = globalThis.process?.env ?? {},
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
