/**
 * Plugin discovery and categorization helpers.
 *
 * Extracted from server.ts. Handles reading the plugins.json manifest,
 * categorizing plugins, building parameter definitions, and aggregating
 * secrets for the plugin management UI.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger, type UUID } from "@elizaos/core";
import { applySignalQrOverride } from "@elizaos/plugin-signal";
import { applyWhatsAppQrOverride } from "@elizaos/plugin-whatsapp";
import type { ElizaConfig } from "../config/config.ts";
import { resolveDefaultAgentWorkspaceDir } from "../providers/workspace.ts";
import { getBundledRuntimePluginIds } from "../runtime/release-plugin-policy.ts";
import {
  type PluginParamInfo,
  validatePluginConfig,
} from "./plugin-validation.ts";
import { findOwnPackageRoot } from "./server-helpers.ts";

const require = createRequire(import.meta.url);

function findPluginsManifestRoot(startDir: string): string {
  let dir = startDir;
  let manifestRoot: string | null = null;

  for (let i = 0; i < 16; i += 1) {
    if (fs.existsSync(path.join(dir, "plugins.json"))) {
      // Keep walking so wrapper wrapper repos can override the nested
      // upstream eliza checkout's package root with the outer workspace manifest.
      manifestRoot = dir;
    }

    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return manifestRoot ?? findOwnPackageRoot(startDir);
}

export type { PluginEntry, PluginParamDef } from "./server-types.ts";

import type { PluginEntry, PluginParamDef } from "./server-types.ts";

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  /** Set automatically when a scan report exists for this skill. */
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

export interface LogEntry {
  timestamp: number;
  level: string;
  message: string;
  source: string;
  tags: string[];
}

export type StreamEventType =
  | "agent_event"
  | "heartbeat_event"
  | "training_event";

export interface StreamEventEnvelope {
  type: StreamEventType;
  version: 1;
  eventId: string;
  ts: number;
  runId?: string;
  seq?: number;
  stream?: string;
  sessionKey?: string;
  agentId?: string;
  roomId?: UUID;
  payload: unknown;
}

export function getReleaseBundledPluginIds(): Set<string> {
  const packageRoot = findOwnPackageRoot(
    import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url)),
  );
  const packageJsonPath = path.join(packageRoot, "package.json");

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    return new Set(
      getBundledRuntimePluginIds(Object.keys(pkg.dependencies ?? {})),
    );
  } catch (err) {
    logger.warn(
      `[eliza-api] Failed to resolve bundled release plugins from package.json: ${err instanceof Error ? err.message : err}`,
    );
    return new Set();
  }
}

export interface PluginIndexEntry {
  id: string;
  dirName?: string;
  name: string;
  npmName?: string;
  description: string;
  tags?: string[];
  category:
    | "ai-provider"
    | "connector"
    | "streaming"
    | "database"
    | "app"
    | "feature";
  envKey: string | null;
  configKeys: string[];
  pluginParameters?: Record<string, Record<string, unknown>>;
  version?: string;
  pluginDeps?: string[];
  configUiHints?: Record<string, Record<string, unknown>>;
  logoUrl?: string;
  icon?: string;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
}

export interface PluginIndex {
  $schema: string;
  generatedAt: string;
  count: number;
  plugins: PluginIndexEntry[];
}

type PackageJsonLike = {
  name?: unknown;
  version?: unknown;
  description?: unknown;
  homepage?: unknown;
  repository?:
    | string
    | {
        type?: string;
        url?: string;
      }
    | null;
  keywords?: unknown;
  logoUrl?: unknown;
  icon?: unknown;
  elizaos?: {
    logoUrl?: unknown;
    configKeys?: unknown;
    configUiHints?: unknown;
  };
  agentConfig?: {
    pluginParameters?: unknown;
    configUiHints?: unknown;
  };
};

type NormalizedPluginParameter = {
  type: string;
  description: string;
  required: boolean;
  sensitive: boolean;
  default?: string;
  options?: string[];
};

type RawPluginParameterDefinition = {
  type?: unknown;
  description?: unknown;
  required?: unknown;
  optional?: unknown;
  sensitive?: unknown;
  default?: unknown;
  options?: unknown;
};

type PluginPackageMetadata = {
  description?: string;
  homepage?: string;
  repository?: string;
  icon?: string | null;
  tags?: string[];
  configKeys?: string[];
  pluginParameters?: Record<string, NormalizedPluginParameter>;
  configUiHints?: Record<string, Record<string, unknown>>;
};

type WorkspacePluginPackage = {
  id: string;
  dirName: string;
  npmName: string;
  packageRoot: string;
  version?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginParameterDefinition(
  value: unknown,
): value is RawPluginParameterDefinition {
  return isRecord(value);
}

function inferSensitiveConfigKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper.includes("_API_KEY") ||
    upper.includes("_SECRET") ||
    upper.includes("_TOKEN") ||
    upper.includes("_PASSWORD") ||
    upper.includes("_PRIVATE_KEY") ||
    upper.includes("_SIGNING_") ||
    upper.includes("ENCRYPTION_")
  );
}

export function findPrimaryEnvKey(configKeys: string[]): string | null {
  return (
    configKeys.find((key) =>
      /(?:_API_KEY|_BOT_TOKEN|_ACCESS_TOKEN|_TOKEN|_SECRET|_PRIVATE_KEY)$/i.test(
        key,
      ),
    ) ?? null
  );
}

function normalizePluginParameters(
  rawParameters: unknown,
): Record<string, NormalizedPluginParameter> | undefined {
  if (!isRecord(rawParameters)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(rawParameters).flatMap(([key, definition]) => {
      if (!isPluginParameterDefinition(definition)) {
        return [];
      }
      const options = Array.isArray(definition.options)
        ? definition.options.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : undefined;

      const normalizedDefinition: NormalizedPluginParameter = {
        type: typeof definition.type === "string" ? definition.type : "string",
        description:
          typeof definition.description === "string" &&
          definition.description.trim().length > 0
            ? definition.description
            : inferDescription(key),
        required:
          definition.required === true ||
          (definition.optional === false && definition.required !== false),
        sensitive:
          definition.sensitive === true || inferSensitiveConfigKey(key),
      };

      if (definition.default !== undefined) {
        normalizedDefinition.default = String(definition.default);
      }
      if (options && options.length > 0) {
        normalizedDefinition.options = options;
      }

      return [[key, normalizedDefinition] as const];
    }),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeConfigUiHints(
  rawHints: unknown,
): Record<string, Record<string, unknown>> | undefined {
  if (!isRecord(rawHints)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(rawHints).filter(([, value]) => isRecord(value)),
  ) as Record<string, Record<string, unknown>>;

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractPluginPackageMetadata(
  pkg: PackageJsonLike,
  keyFallback: { dirName?: string; npmName?: string },
): PluginPackageMetadata {
  const pluginParameters = normalizePluginParameters(
    pkg.agentConfig?.pluginParameters,
  );
  const configKeys =
    Array.isArray(pkg.elizaos?.configKeys) &&
    pkg.elizaos.configKeys.every((value) => typeof value === "string")
      ? [...pkg.elizaos.configKeys]
      : pluginParameters
        ? Object.keys(pluginParameters)
        : undefined;

  return {
    description:
      typeof pkg.description === "string" && pkg.description.trim().length > 0
        ? pkg.description.trim()
        : undefined,
    homepage:
      typeof pkg.homepage === "string" && pkg.homepage.trim().length > 0
        ? pkg.homepage
        : undefined,
    repository:
      normalizeRepositoryUrl(pkg.repository) ??
      deriveElizaRepositoryUrl(keyFallback.npmName, keyFallback.dirName),
    icon:
      typeof pkg.logoUrl === "string"
        ? pkg.logoUrl
        : typeof pkg.elizaos?.logoUrl === "string"
          ? pkg.elizaos.logoUrl
          : typeof pkg.icon === "string"
            ? pkg.icon
            : null,
    tags: normalizePluginMetadataTags(pkg.keywords),
    configKeys,
    pluginParameters,
    configUiHints:
      normalizeConfigUiHints(pkg.agentConfig?.configUiHints) ??
      normalizeConfigUiHints(pkg.elizaos?.configUiHints),
  };
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function normalizeWorkspacePluginPackageName(name: string): string {
  return name.endsWith("-root") ? name.slice(0, -5) : name;
}

function workspacePluginIdFromPackageName(npmName: string): string | null {
  const normalized = normalizeWorkspacePluginPackageName(npmName);
  if (!normalized.startsWith("@elizaos/plugin-")) {
    return null;
  }
  return normalized.slice("@elizaos/plugin-".length);
}

function discoverWorkspacePluginPackages(
  packageRoot: string,
): WorkspacePluginPackage[] {
  const scanRoots = [
    path.join(packageRoot, "plugins"),
    path.join(packageRoot, "packages"),
  ];
  const discovered: WorkspacePluginPackage[] = [];
  const seen = new Set<string>();

  for (const scanRoot of scanRoots) {
    if (!fs.existsSync(scanRoot)) {
      continue;
    }

    for (const dirName of fs.readdirSync(scanRoot).sort()) {
      const rootDir = path.join(scanRoot, dirName);
      if (!fs.statSync(rootDir).isDirectory()) {
        continue;
      }

      const candidates = [
        path.join(rootDir, "typescript", "package.json"),
        path.join(rootDir, "package.json"),
      ];
      for (const packageJsonPath of candidates) {
        if (!fs.existsSync(packageJsonPath)) {
          continue;
        }

        const pkg = readJsonFile<PackageJsonLike>(packageJsonPath);
        const rawName = typeof pkg?.name === "string" ? pkg.name : null;
        if (!rawName) {
          continue;
        }

        const npmName = normalizeWorkspacePluginPackageName(rawName);
        const id = workspacePluginIdFromPackageName(npmName);
        if (!id || seen.has(npmName)) {
          break;
        }

        seen.add(npmName);
        discovered.push({
          id,
          dirName,
          npmName,
          packageRoot: path.dirname(packageJsonPath),
          version: typeof pkg?.version === "string" ? pkg.version : undefined,
        });
        break;
      }
    }
  }

  return discovered;
}

function mergeWorkspacePluginEntries(
  entries: PluginEntry[],
  packageRoot: string,
): PluginEntry[] {
  const seenIds = new Set(entries.map((entry) => entry.id));
  const seenPackages = new Set(
    entries.flatMap((entry) => (entry.npmName ? [entry.npmName] : [])),
  );
  const merged = [...entries];

  for (const plugin of discoverWorkspacePluginPackages(packageRoot)) {
    if (seenIds.has(plugin.id) || seenPackages.has(plugin.npmName)) {
      continue;
    }

    const category = categorizePlugin(plugin.id);
    const bundledMeta = readBundledPluginPackageMetadata(
      packageRoot,
      plugin.dirName,
      plugin.npmName,
    );
    const configKeys = bundledMeta.configKeys ?? [];
    const envKey = findPrimaryEnvKey(configKeys);
    const parameters = bundledMeta.pluginParameters
      ? buildParamDefs(bundledMeta.pluginParameters)
      : [];
    const paramInfos: PluginParamInfo[] = parameters.map((pd) => ({
      key: pd.key,
      required: pd.required,
      sensitive: pd.sensitive,
      type: pd.type,
      description: pd.description,
      default: pd.default,
    }));
    const validation = validatePluginConfig(
      plugin.id,
      category,
      envKey,
      configKeys,
      undefined,
      paramInfos,
    );

    merged.push({
      id: plugin.id,
      name: formatPluginName(plugin.id),
      description: resolvePluginDescription(
        plugin.id,
        formatPluginName(plugin.id),
        category,
        bundledMeta.description,
      ),
      tags: resolvePluginTags(plugin.id, category, bundledMeta.tags),
      enabled: false,
      configured: validation.errors.length === 0,
      envKey,
      category,
      source: "bundled",
      configKeys,
      parameters,
      validationErrors: validation.errors,
      validationWarnings: validation.warnings,
      npmName: plugin.npmName,
      version: plugin.version,
      icon: bundledMeta.icon ?? null,
      homepage: bundledMeta.homepage,
      repository:
        bundledMeta.repository ??
        deriveElizaRepositoryUrl(plugin.npmName, plugin.dirName),
      setupGuideUrl: resolvePluginSetupGuideUrl(plugin.id),
    });

    seenIds.add(plugin.id);
    seenPackages.add(plugin.npmName);
  }

  return merged.sort((a, b) => a.name.localeCompare(b.name));
}

export function maskValue(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function buildParamDefs(
  pluginParams: Record<string, Record<string, unknown>>,
): PluginParamDef[] {
  return Object.entries(pluginParams).map(([key, def]) => {
    const envValue = process.env[key];
    const isSet = Boolean(envValue?.trim());
    const sensitive =
      typeof def.sensitive === "boolean"
        ? def.sensitive
        : inferSensitiveConfigKey(key);
    return {
      key,
      type: (def.type as string) ?? "string",
      description:
        typeof def.description === "string" && def.description.trim().length > 0
          ? def.description
          : inferDescription(key),
      required:
        def.required === true ||
        (def.optional === false && def.required !== false),
      sensitive,
      default: def.default as string | undefined,
      options: Array.isArray(def.options)
        ? (def.options as string[])
        : undefined,
      currentValue: isSet
        ? sensitive
          ? maskValue(envValue ?? "")
          : (envValue ?? "")
        : null,
      isSet,
    };
  });
}

/** Derive a human-readable description from an environment variable key. */
export function inferDescription(key: string): string {
  const upper = key.toUpperCase();

  // Special well-known suffixes
  if (upper.endsWith("_API_KEY"))
    return `API key for ${prefixLabel(key, "_API_KEY")}`;
  if (upper.endsWith("_BOT_TOKEN"))
    return `Bot token for ${prefixLabel(key, "_BOT_TOKEN")}`;
  if (upper.endsWith("_TOKEN"))
    return `Authentication token for ${prefixLabel(key, "_TOKEN")}`;
  if (upper.endsWith("_SECRET"))
    return `Secret for ${prefixLabel(key, "_SECRET")}`;
  if (upper.endsWith("_PRIVATE_KEY"))
    return `Private key for ${prefixLabel(key, "_PRIVATE_KEY")}`;
  if (upper.endsWith("_PASSWORD"))
    return `Password for ${prefixLabel(key, "_PASSWORD")}`;
  if (upper.endsWith("_RPC_URL"))
    return `RPC endpoint URL for ${prefixLabel(key, "_RPC_URL")}`;
  if (upper.endsWith("_BASE_URL"))
    return `Base URL for ${prefixLabel(key, "_BASE_URL")}`;
  if (upper.endsWith("_URL")) return `URL for ${prefixLabel(key, "_URL")}`;
  if (upper.endsWith("_ENDPOINT"))
    return `Endpoint for ${prefixLabel(key, "_ENDPOINT")}`;
  if (upper.endsWith("_HOST"))
    return `Host address for ${prefixLabel(key, "_HOST")}`;
  if (upper.endsWith("_PORT"))
    return `Port number for ${prefixLabel(key, "_PORT")}`;
  if (upper.endsWith("_MODEL") || upper.includes("_MODEL_"))
    return `Model identifier for ${prefixLabel(key, "_MODEL")}`;
  if (upper.endsWith("_VOICE") || upper.includes("_VOICE_"))
    return `Voice setting for ${prefixLabel(key, "_VOICE")}`;
  if (upper.endsWith("_DIR") || upper.endsWith("_PATH"))
    return `Directory path for ${prefixLabel(key, "_DIR").replace(/_PATH$/i, "")}`;
  if (upper.endsWith("_ENABLED") || upper.startsWith("ENABLE_"))
    return `Enable/disable ${prefixLabel(key, "_ENABLED").replace(/^ENABLE_/i, "")}`;
  if (upper.includes("DRY_RUN")) return `Dry-run mode (no real actions)`;
  if (upper.endsWith("_INTERVAL") || upper.endsWith("_INTERVAL_MINUTES"))
    return `Check interval for ${prefixLabel(key, "_INTERVAL")}`;
  if (upper.endsWith("_TIMEOUT") || upper.endsWith("_TIMEOUT_MS"))
    return `Timeout setting for ${prefixLabel(key, "_TIMEOUT")}`;

  // Generic: convert KEY_NAME to "Key name"
  return key
    .split("_")
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");
}

/** Extract the plugin/service prefix label from a key by removing a known suffix. */
export function prefixLabel(key: string, suffix: string): string {
  const raw = key.replace(new RegExp(`${suffix}$`, "i"), "").replace(/_+$/, "");
  if (!raw) return key;
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

// ---------------------------------------------------------------------------
// Blocked env keys — dangerous system vars that must never be written via API
// ---------------------------------------------------------------------------

export const BLOCKED_ENV_KEYS = new Set([
  // System-level injection vectors
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_EXTRA_CA_CERTS",
  // TLS bypass — setting to "0" disables ALL certificate verification,
  // enabling MITM interception of every outbound HTTPS request (API keys
  // for OpenAI, Anthropic, ElevenLabs etc. sent in plaintext headers).
  "NODE_TLS_REJECT_UNAUTHORIZED",
  // Proxy hijack — routes all HTTP/HTTPS traffic through attacker proxy,
  // exposing Authorization headers and API keys in transit.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // Module resolution override
  "NODE_PATH",
  // CA certificate override — trust rogue CAs for MITM
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "PATH",
  "HOME",
  "SHELL",
  // Auth / step-up tokens — writable via API would grant privilege escalation
  "ELIZA_API_TOKEN",
  "ELIZA_WALLET_EXPORT_TOKEN",
  "ELIZA_TERMINAL_RUN_TOKEN",
  "HYPERSCAPE_AUTH_TOKEN",
  // Wallet private keys — writable via API would enable key theft / replacement
  "EVM_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  // Opinion Trade plugin secrets
  "OPINION_PRIVATE_KEY",
  "OPINION_API_KEY",
  // Third-party auth tokens
  "GITHUB_TOKEN",
  // Database connection strings
  "DATABASE_URL",
  "POSTGRES_URL",
]);

/**
 * Top-level config keys accepted by `PUT /api/config`.
 * Keep this in sync with ElizaConfig root fields and include both modern and
 * legacy aliases (e.g. `connectors` + `channels`).
 */
export const CONFIG_WRITE_ALLOWED_TOP_KEYS = new Set([
  "meta",
  "auth",
  "env",
  "wizard",
  "diagnostics",
  "logging",
  "update",
  "browser",
  "ui",
  "skills",
  "plugins",
  "models",
  "nodeHost",
  "agents",
  "tools",
  "bindings",
  "broadcast",
  "audio",
  "messages",
  "commands",
  "approvals",
  "session",
  "web",
  "deploymentTarget",
  "linkedAccounts",
  "serviceRouting",
  "connectors",
  "channels",
  "cron",
  "hooks",
  "discovery",
  "talk",
  "gateway",
  "memory",
  "database",
  "media",
  "cloud",
  "x402",
  "mcp",
  "features",
]);

/**
 * Stream names accepted by `POST /api/agent/event`.
 * Plugins emit events to these streams for the StreamView UI.
 */
export const AGENT_EVENT_ALLOWED_STREAMS = new Set([
  "chat",
  "terminal",
  "game",
  "autonomy",

  "stream",
  "system",
  "message",
  "new_viewer",
  "assistant",
  "thought",
  "action",
  "viewer_stats",
]);

// ---------------------------------------------------------------------------
// Secrets aggregation — collect all sensitive params across plugins
// ---------------------------------------------------------------------------

export interface SecretEntry {
  key: string;
  description: string;
  category: string;
  sensitive: boolean;
  required: boolean;
  isSet: boolean;
  maskedValue: string | null;
  usedBy: Array<{ pluginId: string; pluginName: string; enabled: boolean }>;
}

const AI_PROVIDERS = new Set([
  "OPENAI",
  "ANTHROPIC",
  "GOOGLE",
  "MISTRAL",
  "GROQ",
  "COHERE",
  "TOGETHER",
  "FIREWORKS",
  "PERPLEXITY",
  "DEEPSEEK",
  "XAI",
  "OPENROUTER",
  "ELEVENLABS",
  "REPLICATE",
  "HUGGINGFACE",
]);

export function inferSecretCategory(key: string): string {
  const upper = key.toUpperCase();

  // AI provider keys
  if (upper.endsWith("_API_KEY")) {
    const prefix = upper.replace(/_API_KEY$/, "");
    if (AI_PROVIDERS.has(prefix)) return "ai-provider";
  }

  // Blockchain
  if (
    upper.endsWith("_RPC_URL") ||
    upper.endsWith("_PRIVATE_KEY") ||
    upper.startsWith("SOLANA_") ||
    upper.startsWith("EVM_") ||
    upper.includes("_WALLET_") ||
    upper.includes("HELIUS") ||
    upper.includes("ALCHEMY") ||
    upper.includes("INFURA") ||
    upper.includes("ANKR") ||
    upper.includes("BIRDEYE")
  ) {
    return "blockchain";
  }

  // Connectors
  if (
    upper.endsWith("_BOT_TOKEN") ||
    upper.startsWith("TELEGRAM_") ||
    upper.startsWith("DISCORD_") ||
    upper.startsWith("TWITTER_") ||
    upper.startsWith("SLACK_") ||
    upper.startsWith("FARCASTER_")
  ) {
    return "connector";
  }

  // Auth
  if (
    upper.endsWith("_TOKEN") ||
    upper.endsWith("_SECRET") ||
    upper.endsWith("_PASSWORD")
  ) {
    return "auth";
  }

  return "other";
}

export function aggregateSecrets(plugins: PluginEntry[]): SecretEntry[] {
  const map = new Map<string, SecretEntry>();

  for (const plugin of plugins) {
    for (const param of plugin.parameters) {
      if (!param.sensitive) continue;

      const existing = map.get(param.key);
      if (existing) {
        existing.usedBy.push({
          pluginId: plugin.id,
          pluginName: plugin.name,
          enabled: plugin.enabled,
        });
        // Only mark required if an *enabled* plugin requires it
        if (param.required && plugin.enabled) existing.required = true;
      } else {
        const envValue = process.env[param.key];
        const isSet = Boolean(envValue?.trim());
        map.set(param.key, {
          key: param.key,
          description: param.description || inferDescription(param.key),
          category: inferSecretCategory(param.key),
          sensitive: true,
          required: param.required && plugin.enabled,
          isSet,
          maskedValue: isSet ? maskValue(envValue ?? "") : null,
          usedBy: [
            {
              pluginId: plugin.id,
              pluginName: plugin.name,
              enabled: plugin.enabled,
            },
          ],
        });
      }
    }
  }

  return Array.from(map.values());
}

/**
 * Discover user-installed plugins from the Store (not bundled in the manifest).
 * Reads from config.plugins.installs and tries to enrich with package.json metadata.
 */
export function discoverInstalledPlugins(
  config: ElizaConfig,
  bundledIds: Set<string>,
): PluginEntry[] {
  const installs = config.plugins?.installs;
  if (!installs || typeof installs !== "object") return [];

  const entries: PluginEntry[] = [];

  for (const [packageName, record] of Object.entries(installs)) {
    // Derive a short id from the package name (e.g. "@elizaos/plugin-foo" -> "foo")
    const id = packageName
      .replace(/^@[^/]+\/plugin-/, "")
      .replace(/^@[^/]+\//, "")
      .replace(/^plugin-/, "");

    // Skip if it's already covered by the bundled manifest
    if (bundledIds.has(id)) continue;

    const category = categorizePlugin(id);
    const installPath = (record as Record<string, string>).installPath;

    // Try to read the plugin's package.json for metadata
    let name = packageName;
    let description = `Installed from registry (v${(record as Record<string, string>).version ?? "unknown"})`;
    let pluginConfigKeys: string[] = [];
    let pluginParameters: PluginParamDef[] = [];
    let pluginTags: string[] = [];

    let pluginIcon: string | null = null;
    let pluginHomepage: string | undefined;
    let pluginRepository: string | undefined;
    let installedVersion =
      typeof (record as Record<string, string>).version === "string"
        ? (record as Record<string, string>).version
        : undefined;

    if (installPath) {
      // Check npm layout first, then direct layout
      const candidates = [
        path.join(
          installPath,
          "node_modules",
          ...packageName.split("/"),
          "package.json",
        ),
        path.join(installPath, "package.json"),
      ];
      for (const pkgPath of candidates) {
        try {
          if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
              name?: string;
              description?: string;
              homepage?: string;
              repository?: string | { type?: string; url?: string };
              keywords?: string[];
              elizaos?: {
                displayName?: string;
                configKeys?: string[];
                configDefaults?: Record<string, string>;
                logoUrl?: string;
              };
              agentConfig?: {
                pluginParameters?: Record<string, Record<string, unknown>>;
              };
              logoUrl?: string;
              icon?: string;
              version?: string;
            };
            if (pkg.name) name = pkg.name;
            if (pkg.description) description = pkg.description;
            if (typeof pkg.version === "string" && pkg.version.length > 0) {
              installedVersion = pkg.version;
            }
            pluginTags = normalizePluginMetadataTags(pkg.keywords);
            if (pkg.elizaos?.displayName) name = pkg.elizaos.displayName;
            if (pkg.elizaos?.configKeys) {
              pluginConfigKeys = pkg.elizaos.configKeys;
              const defaults = pkg.elizaos.configDefaults ?? {};
              pluginParameters = pluginConfigKeys.map((key) => ({
                key,
                label: key,
                description: "",
                required: false,
                sensitive:
                  key.toLowerCase().includes("key") ||
                  key.toLowerCase().includes("secret"),
                type: "string" as const,
                default: defaults[key] ?? undefined,
                isSet: Boolean(process.env[key]?.trim()),
                currentValue: null,
              }));
            } else if (pkg.agentConfig?.pluginParameters) {
              pluginConfigKeys = Object.keys(pkg.agentConfig.pluginParameters);
              pluginParameters = buildParamDefs(
                pkg.agentConfig.pluginParameters,
              );
            }
            // Map logoUrl or icon from package.json if available
            pluginIcon =
              pkg.logoUrl ?? pkg.elizaos?.logoUrl ?? pkg.icon ?? null;
            pluginHomepage =
              typeof pkg.homepage === "string" ? pkg.homepage : undefined;
            pluginRepository =
              normalizeRepositoryUrl(pkg.repository) ??
              deriveElizaRepositoryUrl(packageName, `plugin-${id}`);
            break;
          }
        } catch {
          // ignore read errors
        }
      }
    }

    const resolvedDescription = resolvePluginDescription(
      id,
      name,
      category,
      description,
    );
    const resolvedTags = resolvePluginTags(id, category, pluginTags);

    entries.push({
      id,
      name,
      npmName: packageName,
      version: installedVersion,
      releaseStream: (record as { releaseStream?: "latest" | "beta" })
        .releaseStream,
      requestedVersion: (record as { requestedVersion?: string })
        .requestedVersion,
      description: resolvedDescription,
      tags: resolvedTags,
      enabled: false, // Will be updated against the runtime below
      configured:
        pluginConfigKeys.length === 0 || pluginParameters.some((p) => p.isSet),
      envKey: pluginConfigKeys[0] ?? null,
      category,
      source: "store",
      configKeys: pluginConfigKeys,
      parameters: pluginParameters,
      validationErrors: [],
      validationWarnings: [],
      icon: pluginIcon,
      homepage: pluginHomepage,
      repository: pluginRepository,
      setupGuideUrl: resolvePluginSetupGuideUrl(id),
    });
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

// applyWhatsAppQrOverride is imported from ./whatsapp-routes

/**
 * Discover available plugins from the bundled plugins.json manifest.
 * Falls back to filesystem scanning for monorepo development.
 */
export function discoverPluginsFromManifest(): PluginEntry[] {
  const thisDir =
    import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = findOwnPackageRoot(thisDir);
  const manifestRoot = findPluginsManifestRoot(thisDir);
  const manifestPath = path.join(manifestRoot, "plugins.json");

  if (fs.existsSync(manifestPath)) {
    try {
      const index = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as PluginIndex;
      // Keys that are auto-injected by infrastructure and should never be
      // exposed as user-facing "config keys" or parameter definitions.
      const HIDDEN_KEYS = new Set(["VERCEL_OIDC_TOKEN"]);
      const entries = mergeWorkspacePluginEntries(
        index.plugins
          .map((p) => {
            const inferredCategory = categorizePlugin(p.id);
            const category =
              inferredCategory === "feature"
                ? (p.category ?? inferredCategory)
                : inferredCategory;
            const bundledMeta = readBundledPluginPackageMetadata(
              packageRoot,
              p.dirName,
              p.npmName,
            );
            const resolvedConfigKeys =
              p.configKeys.length > 0
                ? p.configKeys
                : (bundledMeta.configKeys ?? []);
            const filteredConfigKeys = resolvedConfigKeys.filter(
              (k) => !HIDDEN_KEYS.has(k),
            );
            const envKey = p.envKey ?? findPrimaryEnvKey(filteredConfigKeys);
            const resolvedPluginParameters = p.pluginParameters
              ? Object.keys(p.pluginParameters).length > 0
                ? p.pluginParameters
                : bundledMeta.pluginParameters
              : bundledMeta.pluginParameters;
            const filteredParams = resolvedPluginParameters
              ? Object.fromEntries(
                  Object.entries(resolvedPluginParameters).filter(
                    ([k]) => !HIDDEN_KEYS.has(k),
                  ),
                )
              : undefined;
            const parameters = filteredParams
              ? buildParamDefs(filteredParams)
              : [];
            const paramInfos: PluginParamInfo[] = parameters.map((pd) => ({
              key: pd.key,
              required: pd.required,
              sensitive: pd.sensitive,
              type: pd.type,
              description: pd.description,
              default: pd.default,
            }));
            const validation = validatePluginConfig(
              p.id,
              category,
              envKey,
              filteredConfigKeys,
              undefined,
              paramInfos,
            );
            const configured = validation.errors.length === 0;

            const description = resolvePluginDescription(
              p.id,
              p.name,
              category,
              p.description || bundledMeta.description,
            );
            const tags = resolvePluginTags(
              p.id,
              category,
              p.tags,
              bundledMeta.tags,
            );

            return {
              id: p.id,
              name: p.name,
              description,
              tags,
              enabled: false,
              configured,
              envKey,
              category,
              source: "bundled" as const,
              configKeys: filteredConfigKeys,
              parameters,
              validationErrors: validation.errors,
              validationWarnings: validation.warnings,
              npmName: p.npmName,
              version: p.version,
              pluginDeps: p.pluginDeps,
              ...((p.configUiHints ?? bundledMeta.configUiHints)
                ? {
                    configUiHints: p.configUiHints ?? bundledMeta.configUiHints,
                  }
                : {}),
              icon: p.logoUrl ?? p.icon ?? bundledMeta.icon ?? null,
              homepage: p.homepage ?? bundledMeta.homepage,
              repository:
                p.repository ??
                bundledMeta.repository ??
                deriveElizaRepositoryUrl(p.npmName, p.dirName),
              setupGuideUrl:
                p.setupGuideUrl ?? resolvePluginSetupGuideUrl(p.id),
            };
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
        packageRoot,
      );

      applyWhatsAppQrOverride(entries, resolveDefaultAgentWorkspaceDir());
      applySignalQrOverride(entries, resolveDefaultAgentWorkspaceDir());

      return entries;
    } catch (err) {
      logger.debug(
        `[eliza-api] Failed to read plugins.json: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Fallback: no manifest found
  logger.debug(
    "[eliza-api] plugins.json not found — run `npm run generate:plugins`",
  );
  return mergeWorkspacePluginEntries([], packageRoot);
}

export function categorizePlugin(
  id: string,
): "ai-provider" | "connector" | "streaming" | "database" | "feature" {
  const aiProviders = [
    "openai",
    "anthropic",
    "groq",
    "xai",
    "ollama",
    "openrouter",
    "google-genai",
    "local-ai",
    "vercel-ai-gateway",
    "deepseek",
    "together",
    "mistral",
    "cohere",
    "perplexity",
    "qwen",
    "minimax",
    "zai",
  ];
  const connectors = [
    "telegram",
    "discord",
    "slack",
    "twitter",
    "whatsapp",
    "signal",
    "imessage",
    "farcaster",
    "bluesky",
    "matrix",
    "nostr",
    "msteams",
    "mattermost",
    "google-chat",
    "feishu",
    "line",
    "zalo",
    "zalouser",
    "tlon",
    "nextcloud-talk",
    "instagram",
    "blooio",
    "twitch",
  ];
  const streamingDests = ["streaming"];
  const databases = ["sql", "localdb", "inmemorydb"];

  if (aiProviders.includes(id)) return "ai-provider";
  if (streamingDests.includes(id)) return "streaming";
  if (connectors.includes(id)) return "connector";
  if (databases.includes(id)) return "database";
  return "feature";
}

const PLUGIN_SETUP_GUIDE_ROOT = "https://docs.eliza.ai/plugin-setup-guide";
const PLUGIN_SETUP_GUIDE_URL_OVERRIDES: Record<string, string> = {
  discord: "https://docs.elizaos.ai/plugin-registry/platform/discord",
};
const ELIZA_REPO_ROOT = "https://github.com/elizaos/eliza";
const PLUGIN_METADATA_TAG_STOPWORDS = new Set([
  "plugin",
  "plugins",
  "eliza",
  "elizaos",
  "eliza",
  "elizaos-plugin",
  "elizaos-plugins",
  "feature",
]);
const SOCIAL_CHAT_CONNECTOR_IDS = new Set([
  "telegram",
  "telegramaccount",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "imessage",
  "matrix",
  "mattermost",
  "msteams",
  "google-chat",
  "feishu",
  "line",
  "zalo",
  "zalouser",
  "tlon",
  "nextcloud-talk",
  "blooio",
  "twilio",
  "twitch",
]);
const SOCIAL_FEED_CONNECTOR_IDS = new Set([
  "twitter",
  "bluesky",
  "farcaster",
  "instagram",
  "nostr",
]);
const PLUGIN_METADATA_CATEGORY_TAGS: Record<string, string[]> = {
  "ai-provider": ["ai-provider", "llm"],
  connector: ["connector"],
  streaming: ["streaming", "broadcast"],
  database: ["database", "storage"],
  app: ["app", "interactive"],
  feature: ["feature"],
};
const PLUGIN_DESCRIPTION_OVERRIDES: Record<string, string> = {
  slack: "Slack workspace connector for chatting with your agent",
  signal: "Signal connector for secure chats with your agent",
  mattermost: "Mattermost connector for team chat with your agent",
  msteams: "Microsoft Teams connector for chatting with your agent",
  "nextcloud-talk": "Nextcloud Talk connector for chatting with your agent",
  blooio: "Blooio SMS connector for texting your agent",
  github:
    "GitHub connector for issues, pull requests, and repository automation",
  "gmail-watch":
    "Gmail watcher that turns new incoming emails into agent events",
  mcp: "Model Context Protocol connector for external tools and servers",
};

const PLUGIN_SETUP_GUIDE_ANCHORS: Record<string, string> = {
  openai: "#openai",
  anthropic: "#anthropic",
  "google-genai": "#google-gemini",
  groq: "#groq",
  openrouter: "#openrouter",
  xai: "#xai-grok",
  ollama: "#ollama-local-models",
  "local-ai": "#local-ai",
  "vercel-ai-gateway": "#vercel-ai-gateway",
  discord: "#discord",
  telegram: "#telegram",
  twitter: "#twitter--x",
  slack: "#slack",
  whatsapp: "#whatsapp",
  instagram: "#instagram",
  bluesky: "#bluesky",
  farcaster: "#farcaster",
  github: "#github",
  twitch: "#twitch",
  twilio: "#twilio-sms--voice",
  matrix: "#matrix",
  msteams: "#microsoft-teams",
  "google-chat": "#google-chat",
  signal: "#signal",
  imessage: "#imessage-macos-only",
  blooio: "#blooio-sms-via-api",
  nostr: "#nostr",
  line: "#line",
  feishu: "#feishu-lark",
  mattermost: "#mattermost",
  "nextcloud-talk": "#nextcloud-talk",
  tlon: "#tlon-urbit",
  zalo: "#zalo-vietnam-messaging",
  zalouser: "#zalo-user-personal",
  acp: "#acp-agent-communication-protocol",
  mcp: "#mcp-model-context-protocol",
  iq: "#iq-solana-on-chain",
  "gmail-watch": "#gmail-watch",
  streaming: "#streaming",
};

export function resolvePluginSetupGuideUrl(id: string): string | undefined {
  const override = PLUGIN_SETUP_GUIDE_URL_OVERRIDES[id];
  if (override) {
    return override;
  }
  const anchor = PLUGIN_SETUP_GUIDE_ANCHORS[id];
  return anchor ? `${PLUGIN_SETUP_GUIDE_ROOT}${anchor}` : undefined;
}

export function normalizeRepositoryUrl(
  repository: string | { type?: string; url?: string } | null | undefined,
): string | undefined {
  const raw =
    typeof repository === "string"
      ? repository.trim()
      : repository?.url?.trim() || "";
  if (!raw) return undefined;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  if (raw.startsWith("git@github.com:")) {
    return `https://github.com/${raw
      .slice("git@github.com:".length)
      .replace(/\.git$/, "")}`;
  }
  if (raw.startsWith("git+https://")) return raw.slice(4).replace(/\.git$/, "");
  if (raw.startsWith("https://") || raw.startsWith("http://")) {
    return raw.replace(/\.git$/, "");
  }
  return undefined;
}

export function deriveElizaRepositoryUrl(
  npmName: string | undefined,
  dirName: string | undefined,
): string | undefined {
  if (!npmName?.startsWith("@elizaos/")) return undefined;
  if (!dirName?.startsWith("plugin-")) return undefined;
  return `${ELIZA_REPO_ROOT}/tree/main/packages/${dirName}`;
}

export function normalizePluginMetadataTag(tag: string): string | null {
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || PLUGIN_METADATA_TAG_STOPWORDS.has(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizePluginMetadataTags(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const normalized = normalizePluginMetadataTag(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

export function mergePluginMetadataTags(...sources: unknown[]): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const tag of normalizePluginMetadataTags(source)) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

export function pluginIdTags(id: string): string[] {
  return normalizePluginMetadataTags([id, ...id.split("-")]);
}

export function connectorMetadataTags(id: string): string[] {
  if (SOCIAL_CHAT_CONNECTOR_IDS.has(id)) {
    return ["social", "social-chat", "messaging"];
  }
  if (SOCIAL_FEED_CONNECTOR_IDS.has(id)) {
    return ["social", "social-feed"];
  }
  return ["integration"];
}

export function resolvePluginDescription(
  id: string,
  name: string,
  category: PluginEntry["category"],
  description: string | undefined,
): string {
  const displayName = name.startsWith("@") ? formatPluginName(id) : name;
  const trimmed = description?.trim();
  if (trimmed) return trimmed;
  if (PLUGIN_DESCRIPTION_OVERRIDES[id]) return PLUGIN_DESCRIPTION_OVERRIDES[id];
  if (category === "ai-provider") {
    return `${displayName} AI provider for Eliza agents`;
  }
  if (category === "connector") {
    if (SOCIAL_CHAT_CONNECTOR_IDS.has(id)) {
      return `${displayName} connector for chatting with your agent`;
    }
    if (SOCIAL_FEED_CONNECTOR_IDS.has(id)) {
      return `${displayName} social connector for connecting your agent to ${displayName}`;
    }
    return `${displayName} connector plugin for Eliza agents`;
  }
  if (category === "streaming") {
    return `${displayName} streaming destination for live agent broadcasts`;
  }
  if (category === "database") {
    return `${displayName} storage plugin for Eliza agents`;
  }
  if (category === "app") {
    return `${displayName} interactive app for Eliza agents`;
  }
  return `${displayName} plugin for Eliza agents`;
}

export function resolvePluginTags(
  id: string,
  category: PluginEntry["category"],
  ...sources: unknown[]
): string[] {
  return mergePluginMetadataTags(
    ...sources,
    PLUGIN_METADATA_CATEGORY_TAGS[category] ?? [],
    category === "connector" ? connectorMetadataTags(id) : [],
    pluginIdTags(id),
  );
}

export function formatPluginName(id: string): string {
  return id
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function readBundledPluginPackageMetadata(
  packageRoot: string,
  dirName: string | undefined,
  npmName?: string,
): PluginPackageMetadata {
  const candidates = dirName
    ? [
        path.join(packageRoot, "packages", dirName, "package.json"),
        path.join(
          packageRoot,
          "plugins",
          dirName,
          "typescript",
          "package.json",
        ),
        path.join(packageRoot, "plugins", dirName, "package.json"),
      ]
    : [];

  if (npmName) {
    try {
      candidates.push(require.resolve(`${npmName}/package.json`));
    } catch {
      // Ignore resolution failures for packages that are not installed locally.
    }
  }

  const metadata: PluginPackageMetadata = {
    repository: deriveElizaRepositoryUrl(npmName, dirName),
    tags: [],
  };

  const seen = new Set<string>();
  for (const pkgPath of candidates) {
    if (!pkgPath || seen.has(pkgPath) || !fs.existsSync(pkgPath)) {
      continue;
    }
    seen.add(pkgPath);

    try {
      const pkg = JSON.parse(
        fs.readFileSync(pkgPath, "utf-8"),
      ) as PackageJsonLike;
      const extracted = extractPluginPackageMetadata(pkg, { dirName, npmName });

      if (!metadata.description && extracted.description) {
        metadata.description = extracted.description;
      }
      if (!metadata.homepage && extracted.homepage) {
        metadata.homepage = extracted.homepage;
      }
      if (
        (!metadata.repository ||
          metadata.repository === deriveElizaRepositoryUrl(npmName, dirName)) &&
        extracted.repository
      ) {
        metadata.repository = extracted.repository;
      }
      if (metadata.icon == null && extracted.icon != null) {
        metadata.icon = extracted.icon;
      }
      if (
        (metadata.tags?.length ?? 0) === 0 &&
        (extracted.tags?.length ?? 0) > 0
      ) {
        metadata.tags = extracted.tags;
      }
      if (
        (metadata.configKeys?.length ?? 0) === 0 &&
        (extracted.configKeys?.length ?? 0) > 0
      ) {
        metadata.configKeys = extracted.configKeys;
      }
      if (!metadata.pluginParameters && extracted.pluginParameters) {
        metadata.pluginParameters = extracted.pluginParameters;
      }
      if (!metadata.configUiHints && extracted.configUiHints) {
        metadata.configUiHints = extracted.configUiHints;
      }
    } catch {
      // Ignore malformed package metadata and continue to the next candidate.
    }
  }

  return metadata;
}
