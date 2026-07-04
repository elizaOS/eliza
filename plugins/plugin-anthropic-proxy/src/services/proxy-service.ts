/**
 * AnthropicProxyService
 *
 * Wraps an in-process http proxy (when mode=inline) or validates an upstream
 * URL (when mode=shared). In off mode, the agent runs without a proxy.
 *
 * The plugin's init() is responsible for setting ANTHROPIC_BASE_URL based on
 * the mode and getProxyUrl().
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type { Pair } from "../proxy/sanitize.js";
import { ProxyServer } from "../proxy/server.js";
import type { SystemPromptStripConfig } from "../proxy/system-prompt.js";

export type ProxyMode = "inline" | "shared" | "off";

export const ANTHROPIC_PROXY_SERVICE_NAME = "anthropic-proxy";

export interface ProxyServiceConfig {
  mode: ProxyMode;
  port: number;
  bindHost: string;
  upstream?: string;
  credentialsPath?: string;
  configPath?: string;
  envToken?: string;
  proxyAuthToken?: string;
  verbose: boolean;
  fingerprintConfig?: FingerprintConfig;
  configError?: string;
}

export interface FingerprintConfig {
  replacements?: ReadonlyArray<Pair>;
  toolRenames?: ReadonlyArray<Pair>;
  propRenames?: ReadonlyArray<Pair>;
  reverseMap?: ReadonlyArray<Pair>;
  systemPromptStrip?: SystemPromptStripConfig;
}

function readEnv(name: string): string | undefined {
  if (typeof process === "undefined") return undefined;
  const v = process.env[name];
  return v === undefined || v === "" ? undefined : v;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return LOOPBACK_HOSTS.has(normalized) || normalized.startsWith("127.");
}

function isPrivateHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (isLoopbackHost(normalized)) return true;
  if (normalized.endsWith(".local") || normalized.endsWith(".internal")) return true;
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  const match = normalized.match(/^172\.(\d+)\./);
  return !!match && Number(match[1]) >= 16 && Number(match[1]) <= 31;
}

function validateSharedUpstream(upstream: string): string {
  const url = new URL(upstream);
  if (url.protocol === "https:") return upstream.replace(/\/$/, "");
  if (url.protocol === "http:" && isPrivateHost(url.hostname)) {
    return upstream.replace(/\/$/, "");
  }
  throw new Error(
    "CLAUDE_MAX_PROXY_UPSTREAM must use https unless it points to a loopback/private host"
  );
}

function shouldSetBaseUrl(current: string | undefined): boolean {
  if (current === undefined || current === "") return true;
  return current.toLowerCase() === "auto";
}

function setAnthropicBaseUrl(target: string): void {
  const current = process.env.ANTHROPIC_BASE_URL;
  if (shouldSetBaseUrl(current)) {
    process.env.ANTHROPIC_BASE_URL = target;
    logger.info(`[anthropic-proxy] set ANTHROPIC_BASE_URL=${target}`);
  }
}

function readPairArray(value: unknown, field: string): ReadonlyArray<Pair> {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of [from, to] string pairs`);
  }
  return value.map((entry, index): Pair => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string" ||
      entry[0].length === 0
    ) {
      throw new Error(`${field}[${index}] must be [from, to] strings`);
    }
    return [entry[0], entry[1]];
  });
}

function readSystemPromptStrip(value: unknown): SystemPromptStripConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("systemPromptStrip must be an object");
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.start !== "string" ||
    record.start.length === 0 ||
    typeof record.end !== "string" ||
    record.end.length === 0 ||
    typeof record.paraphrase !== "string" ||
    record.paraphrase.length === 0
  ) {
    throw new Error("systemPromptStrip requires non-empty start, end, and paraphrase strings");
  }
  const minStripLen = record.minStripLen === undefined ? undefined : Number(record.minStripLen);
  if (minStripLen !== undefined && (!Number.isFinite(minStripLen) || minStripLen < 0)) {
    throw new Error("systemPromptStrip.minStripLen must be a non-negative number");
  }
  return {
    start: record.start,
    end: record.end,
    paraphrase: record.paraphrase,
    ...(minStripLen !== undefined ? { minStripLen } : {}),
  };
}

function loadFingerprintConfig(configPath: string): FingerprintConfig {
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config root must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const config: FingerprintConfig = {};
  if (record.replacements !== undefined) {
    config.replacements = readPairArray(record.replacements, "replacements");
  }
  if (record.toolRenames !== undefined) {
    config.toolRenames = readPairArray(record.toolRenames, "toolRenames");
  }
  if (record.propRenames !== undefined) {
    config.propRenames = readPairArray(record.propRenames, "propRenames");
  }
  if (record.reverseMap !== undefined) {
    config.reverseMap = readPairArray(record.reverseMap, "reverseMap");
  }
  if (record.systemPromptStrip !== undefined) {
    config.systemPromptStrip = readSystemPromptStrip(record.systemPromptStrip);
  }
  return config;
}

function resolveFingerprintConfig(): {
  configPath?: string;
  fingerprintConfig?: FingerprintConfig;
  configError?: string;
} {
  const explicit = readEnv("CLAUDE_MAX_PROXY_CONFIG_PATH");
  const configPath = explicit ? resolve(explicit) : resolve("config.json");
  if (!existsSync(configPath)) {
    return explicit
      ? {
          configPath,
          configError: `CLAUDE_MAX_PROXY_CONFIG_PATH not found: ${configPath}`,
        }
      : {};
  }
  try {
    return {
      configPath,
      fingerprintConfig: loadFingerprintConfig(configPath),
    };
  } catch (error) {
    // error-policy:J3 untrusted-input sanitizing — an unreadable/invalid
    // fingerprint config becomes an explicit typed configError (the service
    // then refuses to start the proxy and surfaces it via startError +
    // PROXY_STATUS); no partial/default config is fabricated.
    return {
      configPath,
      configError: `Invalid anthropic proxy config ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export function resolveConfig(): ProxyServiceConfig {
  const modeRaw = (readEnv("CLAUDE_MAX_PROXY_MODE") ?? "inline").toLowerCase();
  const validMode = modeRaw === "off" || modeRaw === "shared" || modeRaw === "inline";
  const mode: ProxyMode = validMode ? modeRaw : "off";

  const portRaw = readEnv("CLAUDE_MAX_PROXY_PORT");
  const port = portRaw ? Number.parseInt(portRaw, 10) || 18801 : 18801;
  const fingerprint = resolveFingerprintConfig();

  return {
    mode,
    port,
    bindHost: readEnv("CLAUDE_MAX_PROXY_BIND_HOST") ?? "127.0.0.1",
    upstream: readEnv("CLAUDE_MAX_PROXY_UPSTREAM"),
    credentialsPath: readEnv("CLAUDE_MAX_CREDENTIALS_PATH"),
    configPath: fingerprint.configPath,
    envToken: readEnv("CLAUDE_CODE_OAUTH_TOKEN"),
    proxyAuthToken: readEnv("CLAUDE_MAX_PROXY_AUTH_TOKEN"),
    verbose: readEnv("CLAUDE_MAX_PROXY_VERBOSE") === "true",
    fingerprintConfig: fingerprint.fingerprintConfig,
    configError:
      fingerprint.configError ??
      (validMode ? undefined : `Invalid CLAUDE_MAX_PROXY_MODE: ${modeRaw}`),
  };
}

export class AnthropicProxyService extends Service {
  static serviceType = ANTHROPIC_PROXY_SERVICE_NAME;
  capabilityDescription =
    "Routes Anthropic API traffic through a Claude Max/Pro subscription via Claude Code OAuth tokens";

  private proxyConfig: ProxyServiceConfig | null = null;
  private server: ProxyServer | null = null;
  private effectiveMode: ProxyMode = "off";
  private effectiveUrl: string | null = null;
  private startError: string | null = null;

  static async start(runtime: IAgentRuntime): Promise<AnthropicProxyService> {
    const service = new AnthropicProxyService(runtime);
    const config = resolveConfig();
    service.proxyConfig = config;
    if (config.configError) {
      service.startError = config.configError;
      logger.warn(`[anthropic-proxy] ${service.startError} — falling back to off`);
      service.effectiveMode = "off";
      service.effectiveUrl = null;
      return service;
    }

    if (config.mode === "off") {
      service.effectiveMode = "off";
      service.effectiveUrl = null;
      logger.info("[anthropic-proxy] mode=off — proxy disabled");
      return service;
    }

    if (config.mode === "shared") {
      if (!config.upstream) {
        logger.warn(
          "[anthropic-proxy] mode=shared but CLAUDE_MAX_PROXY_UPSTREAM not set — falling back to off"
        );
        service.effectiveMode = "off";
        return service;
      }
      service.effectiveMode = "shared";
      try {
        service.effectiveUrl = validateSharedUpstream(config.upstream);
      } catch (e) {
        // error-policy:J4 explicit user-facing degrade — an invalid shared
        // upstream degrades to the documented "off" mode (agent keeps running
        // on direct billing); the failure stays observable via startError,
        // the PROXY_STATUS action, and GET /api/anthropic-proxy/status.
        service.startError = (e as Error).message;
        logger.warn(`[anthropic-proxy] ${service.startError} — falling back to off`);
        service.effectiveMode = "off";
        return service;
      }
      setAnthropicBaseUrl(service.effectiveUrl);
      logger.info(`[anthropic-proxy] mode=shared — using upstream ${service.effectiveUrl}`);
      return service;
    }

    // inline
    if (!isLoopbackHost(config.bindHost) && !config.proxyAuthToken) {
      service.startError =
        "CLAUDE_MAX_PROXY_AUTH_TOKEN is required when CLAUDE_MAX_PROXY_BIND_HOST is not loopback";
      logger.warn(`[anthropic-proxy] ${service.startError} — falling back to off`);
      service.effectiveMode = "off";
      return service;
    }
    const server = new ProxyServer({
      port: config.port,
      bindHost: config.bindHost,
      credentialsPath: config.credentialsPath,
      envToken: config.envToken,
      proxyAuthToken: config.proxyAuthToken,
      verbose: config.verbose,
      replacements: config.fingerprintConfig?.replacements,
      toolRenames: config.fingerprintConfig?.toolRenames,
      propRenames: config.fingerprintConfig?.propRenames,
      reverseMap: config.fingerprintConfig?.reverseMap,
      systemPromptStrip: config.fingerprintConfig?.systemPromptStrip,
      logger: {
        info: (m) => logger.info(`[anthropic-proxy] ${m}`),
        warn: (m) => logger.warn(`[anthropic-proxy] ${m}`),
        error: (m) => logger.error(`[anthropic-proxy] ${m}`),
      },
    });
    try {
      await server.start();
      service.server = server;
      service.effectiveMode = "inline";
      service.effectiveUrl = server.getUrl();
      setAnthropicBaseUrl(service.effectiveUrl);
      logger.info(`[anthropic-proxy] mode=inline — listening on ${service.effectiveUrl}`);
    } catch (e) {
      // error-policy:J4 explicit user-facing degrade — a failed inline proxy
      // start (missing credentials, port in use) degrades to the documented
      // "off" mode instead of crashing agent boot; the failure stays
      // observable via startError, the PROXY_STATUS action, and
      // GET /api/anthropic-proxy/status.
      service.startError = (e as Error).message;
      logger.warn(
        `[anthropic-proxy] failed to start inline proxy (${service.startError}). ` +
          "Run 'claude auth login' to authenticate. Service will degrade to off mode."
      );
      service.effectiveMode = "off";
      service.effectiveUrl = null;
    }
    return service;
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.stop();
      this.server = null;
    }
    this.effectiveMode = "off";
    this.effectiveUrl = null;
  }

  getProxyUrl(): string | null {
    return this.effectiveUrl;
  }

  getEffectiveMode(): ProxyMode {
    return this.effectiveMode;
  }

  getServer(): ProxyServer | null {
    return this.server;
  }

  getConfig(): ProxyServiceConfig | null {
    return this.proxyConfig;
  }

  getStartError(): string | null {
    return this.startError;
  }

  async getStatus(): Promise<{
    mode: ProxyMode;
    url: string | null;
    listening: boolean;
    startError: string | null;
    stats: ReturnType<ProxyServer["getStats"]> | null;
    upstream?: { reachable: boolean; status?: number; error?: string };
  }> {
    let stats: ReturnType<ProxyServer["getStats"]> | null = null;
    if (this.server) stats = this.server.getStats();

    let upstream: { reachable: boolean; status?: number; error?: string } | undefined;
    if (this.effectiveMode === "shared" && this.effectiveUrl) {
      try {
        const r = await fetch(`${this.effectiveUrl}/health`, {
          signal: AbortSignal.timeout(2000),
        });
        upstream = { reachable: r.ok, status: r.status };
      } catch (e) {
        // error-policy:J4 explicit user-facing degrade — the upstream health
        // probe's failure IS the answer: the status DTO reports an explicit
        // { reachable: false, error } state, never a fake-healthy upstream.
        upstream = {
          reachable: false,
          error: (e as Error).message,
        };
      }
    }

    return {
      mode: this.effectiveMode,
      url: this.effectiveUrl,
      listening: this.server?.isListening() ?? false,
      startError: this.startError,
      stats,
      upstream,
    };
  }
}
