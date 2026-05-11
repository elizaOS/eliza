#!/usr/bin/env node
/**
 * Generate plugins.json — a static manifest of all available plugins
 * that ships with the eliza package.
 *
 * Fetches plugin metadata from the elizaos-plugins registry and writes
 * plugins.json to the eliza package root.
 *
 * Run from the eliza package directory:
 *   node scripts/generate-plugin-index.js
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const packageRoot = path.resolve(__dirname, "..");
const outputPath = path.join(packageRoot, "plugins.json");
const overridesPath = path.join(__dirname, "plugin-metadata-overrides.json");

// Registry URL
const GENERATED_REGISTRY_URL =
  "https://plugins.elizacloud.ai/generated-registry.json";

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

const AI_PROVIDERS = new Set([
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
  "minimax",
  "zai",
]);

export const STREAMING_DESTINATIONS = new Set(["streaming"]);

const CONNECTORS = new Set([
  "telegram",
  "discord",
  "slack",
  "twitter",
  "whatsapp",
  "signal",
  "imessage",
  "bluebubbles",
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
  "twitch",
  "nextcloud-talk",
  "instagram",
  "wechat",
]);

const SOCIAL_CHAT_CONNECTORS = new Set([
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "signal",
  "imessage",
  "bluebubbles",
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

const SOCIAL_FEED_CONNECTORS = new Set([
  "twitter",
  "bluesky",
  "farcaster",
  "instagram",
  "nostr",
]);

const DATABASES = new Set(["sql", "localdb", "inmemorydb"]);
const NATIVE_RUNTIME_FEATURE_PLUGIN_IDS = new Set([
  "knowledge",
  "relationships",
  "trajectories",
]);
const BUILT_IN_ADVANCED_CAPABILITY_PLUGIN_IDS = new Set(["experience"]);

export const PLUGIN_SETUP_GUIDE_ROOT =
  "https://docs.eliza.ai/plugin-setup-guide";

const SETUP_GUIDE_ANCHORS = {
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
  telegram: "https://docs.elizaos.ai/guides/tutorial-telegram-bot",
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
  wechat: "#wechat",
  acp: "#acp-agent-communication-protocol",
  mcp: "#mcp-model-context-protocol",
  iq: "#iq-solana-on-chain",
  "gmail-watch": "#gmail-watch",
  streaming: "#streaming",
};

const ELIZA_REPO_ROOT = "https://github.com/elizaOS/eliza";
const TAG_STOPWORDS = new Set([
  "plugin",
  "plugins",
  "eliza",
  "elizaos",
  "elizaos-plugin",
  "elizaos-plugins",
  "feature",
]);
const TAG_ALIASES = new Map([
  ["ai", "llm"],
  ["ai-agents", "agents"],
  ["computer-vision", "vision"],
  ["issue-tracking", "project-management"],
  ["project-management", "project-management"],
  ["text-to-speech", "text-to-speech"],
  ["tts", "text-to-speech"],
  ["voice-synthesis", "text-to-speech"],
  ["speech-to-text", "speech-to-text"],
  ["stt", "speech-to-text"],
  ["file-storage", "storage"],
  ["long-term-memory", "memory"],
  ["short-term-memory", "memory"],
  ["multi-agent", "orchestration"],
  ["command-line", "developer-tools"],
]);
const CATEGORY_TAGS = {
  "ai-provider": ["ai-provider", "llm"],
  connector: ["connector"],
  streaming: ["streaming", "broadcast"],
  database: ["database", "storage"],
  app: ["app", "interactive"],
  feature: [],
};

const metadataOverrides = fs.existsSync(overridesPath)
  ? JSON.parse(fs.readFileSync(overridesPath, "utf8"))
  : {};

export function categorize(id) {
  if (AI_PROVIDERS.has(id)) return "ai-provider";
  if (STREAMING_DESTINATIONS.has(id)) return "streaming";
  if (CONNECTORS.has(id)) return "connector";
  if (DATABASES.has(id)) return "database";
  return "feature";
}

export function resolveSetupGuideUrl(id) {
  const anchor = SETUP_GUIDE_ANCHORS[id];
  if (!anchor) return undefined;
  // Full URLs are used as-is; anchors are appended to the default root
  return anchor.startsWith("http")
    ? anchor
    : `${PLUGIN_SETUP_GUIDE_ROOT}${anchor}`;
}

export function normalizeRepositoryUrl(repository) {
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

function deriveRepositoryUrl(npmName, dirName) {
  if (!npmName?.startsWith("@elizaai/") && !npmName?.startsWith("@elizaos/")) {
    return undefined;
  }
  if (!dirName?.startsWith("plugin-")) return undefined;
  return `${ELIZA_REPO_ROOT}/tree/main/packages/${dirName}`;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inferSensitiveKey(key) {
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

function normalizePluginParameters(rawParameters) {
  if (!isRecord(rawParameters)) {
    return undefined;
  }

  const normalized = {};
  for (const [key, definition] of Object.entries(rawParameters)) {
    if (!isRecord(definition)) continue;

    const normalizedDefinition = {
      type: typeof definition.type === "string" ? definition.type : "string",
      description:
        typeof definition.description === "string" && definition.description
          ? definition.description
          : inferKeyDescription(key),
      required:
        definition.required === true ||
        (definition.optional === false && definition.required !== false),
      sensitive: definition.sensitive === true || inferSensitiveKey(key),
    };

    if (definition.default !== undefined) {
      normalizedDefinition.default = String(definition.default);
    }
    if (Array.isArray(definition.options)) {
      const options = definition.options.filter(
        (value) => typeof value === "string",
      );
      if (options.length > 0) {
        normalizedDefinition.options = options;
      }
    }

    normalized[key] = normalizedDefinition;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeConfigUiHints(rawHints) {
  if (!isRecord(rawHints)) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(rawHints).filter(([, value]) => isRecord(value)),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function extractPackageMetadata(pkg, dirName, npmName) {
  const pluginParameters = normalizePluginParameters(
    pkg.agentConfig?.pluginParameters,
  );
  const configKeys =
    Array.isArray(pkg.elizaos?.configKeys) &&
    pkg.elizaos.configKeys.every((value) => typeof value === "string")
      ? [...pkg.elizaos.configKeys]
      : pluginParameters
        ? Object.keys(pluginParameters)
        : [];

  return {
    description: typeof pkg.description === "string" ? pkg.description : "",
    homepage: typeof pkg.homepage === "string" ? pkg.homepage : undefined,
    repository:
      normalizeRepositoryUrl(pkg.repository) ??
      deriveRepositoryUrl(npmName, dirName),
    icon: pkg.logoUrl ?? pkg.elizaos?.logoUrl ?? pkg.icon ?? undefined,
    tags: normalizeTags(pkg.keywords ?? []),
    configKeys,
    pluginParameters,
    configUiHints:
      normalizeConfigUiHints(pkg.agentConfig?.configUiHints) ??
      normalizeConfigUiHints(pkg.elizaos?.configUiHints),
  };
}

function mergePackageMetadata(base, next) {
  return {
    description: base.description || next.description || "",
    homepage: base.homepage || next.homepage,
    repository: base.repository || next.repository,
    icon: base.icon || next.icon,
    tags: base.tags?.length ? base.tags : next.tags,
    configKeys: base.configKeys?.length ? base.configKeys : next.configKeys,
    pluginParameters: base.pluginParameters || next.pluginParameters,
    configUiHints: base.configUiHints || next.configUiHints,
  };
}

function readLocalPackageMetadata(dirName, npmName) {
  if (!dirName) return {};
  const candidates = [
    path.join(packageRoot, "packages", dirName, "package.json"),
    path.join(
      packageRoot,
      "eliza",
      "plugins",
      dirName,
      "typescript",
      "package.json",
    ),
    path.join(packageRoot, "eliza", "plugins", dirName, "package.json"),
  ];

  let metadata = {
    repository: deriveRepositoryUrl(npmName, dirName),
    tags: [],
    configKeys: [],
  };

  for (const pkgPath of candidates) {
    if (!fs.existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      metadata = mergePackageMetadata(
        metadata,
        extractPackageMetadata(pkg, dirName, npmName),
      );
    } catch {
      // Ignore malformed package.json files and continue.
    }
  }

  return metadata;
}

async function fetchPublishedPackageManifest(packageName, version) {
  if (!packageName) return {};

  const dirName = `plugin-${
    packageName
      .split("/")
      .pop()
      ?.replace(/^plugin-/, "") ?? ""
  }`;
  const fetchVersionMetadata = async (candidateVersion) => {
    if (!candidateVersion) return {};
    try {
      const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(candidateVersion)}`,
      );
      if (!response.ok) return {};
      const pkg = await response.json();
      return extractPackageMetadata(pkg, dirName, packageName);
    } catch {
      return {};
    }
  };

  const hasConfigMetadata = (metadata) =>
    Array.isArray(metadata?.configKeys) && metadata.configKeys.length > 0;

  let metadata = await fetchVersionMetadata(version);
  if (hasConfigMetadata(metadata)) {
    return metadata;
  }

  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}`,
    );
    if (!response.ok) return metadata;
    const packument = await response.json();
    const tags = packument["dist-tags"] ?? {};
    const fallbackVersions = [
      tags.next,
      tags.alpha,
      tags.latest,
      version,
    ].filter(Boolean);

    const seen = new Set();
    for (const candidateVersion of fallbackVersions) {
      if (!candidateVersion || seen.has(candidateVersion)) continue;
      seen.add(candidateVersion);
      const candidateMetadata = await fetchVersionMetadata(candidateVersion);
      metadata = mergePackageMetadata(metadata, candidateMetadata);
      if (hasConfigMetadata(metadata)) {
        return metadata;
      }
    }
  } catch {
    // Ignore packument fallback failures and return the best metadata we found.
  }

  return metadata;
}

async function fetchPublishedPackageManifestMap(packages) {
  const uniquePackages = [];
  const seen = new Set();
  for (const entry of packages) {
    if (!entry?.name || !entry?.version) continue;
    const key = `${entry.name}@${entry.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniquePackages.push(entry);
  }

  const results = new Map();
  let index = 0;
  const workerCount = Math.min(8, uniquePackages.length);

  async function worker() {
    while (index < uniquePackages.length) {
      const current = uniquePackages[index];
      index += 1;
      results.set(
        current.name,
        await fetchPublishedPackageManifest(current.name, current.version),
      );
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

function normalizeTag(tag) {
  if (typeof tag !== "string") return null;
  const normalized = tag
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized || TAG_STOPWORDS.has(normalized)) return null;
  return TAG_ALIASES.get(normalized) ?? normalized;
}

function normalizeTags(values) {
  const tags = [];
  const seen = new Set();
  for (const value of values ?? []) {
    const normalized = normalizeTag(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    tags.push(normalized);
  }
  return tags;
}

function idTags(id) {
  const parts = id.split("-").filter(Boolean);
  return normalizeTags([id, ...parts]);
}

function mergeTags(...sources) {
  return normalizeTags(
    sources.flatMap((source) => (Array.isArray(source) ? source : [])),
  );
}

export function connectorTags(id) {
  if (SOCIAL_CHAT_CONNECTORS.has(id)) {
    return ["social", "social-chat", "messaging"];
  }
  if (SOCIAL_FEED_CONNECTORS.has(id)) {
    return ["social", "social-feed"];
  }
  return ["integration"];
}

export function inferDescription(id, name, category) {
  switch (category) {
    case "ai-provider":
      return `${name} model provider for chat and inference workloads.`;
    case "connector":
      if (SOCIAL_CHAT_CONNECTORS.has(id)) {
        return `${name} connector for chatting with your agent.`;
      }
      if (SOCIAL_FEED_CONNECTORS.has(id)) {
        return `${name} social connector for connecting your agent to ${name}.`;
      }
      return `${name} connector for integrating external workflows with agents.`;
    case "streaming":
      return `${name} streaming destination for broadcasting live agent output.`;
    case "database":
      return `${name} database adapter for persistent agent state and memory.`;
    case "app":
      return `${name} interactive app for agents.`;
    default:
      return `${name} plugin for ${id.replace(/-/g, " ")} workflows.`;
  }
}

function findEnvKey(configKeys) {
  return (
    configKeys.find(
      (k) =>
        k.endsWith("_API_KEY") ||
        k.endsWith("_BOT_TOKEN") ||
        k.endsWith("_TOKEN"),
    ) ?? null
  );
}

function formatName(id) {
  return id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Parameter inference from key names (used when agentConfig is absent)
// ---------------------------------------------------------------------------

function isSensitiveKey(key) {
  const u = key.toUpperCase();
  return (
    u.includes("_API_KEY") ||
    u.includes("_SECRET") ||
    u.includes("_TOKEN") ||
    u.includes("_PASSWORD") ||
    u.includes("_PRIVATE_KEY") ||
    u.includes("_SIGNING_") ||
    u.includes("ENCRYPTION_")
  );
}

function isBooleanKey(key) {
  const u = key.toUpperCase();
  return (
    u.includes("ENABLED") ||
    u.includes("_ENABLE_") ||
    u.startsWith("ENABLE_") ||
    u.includes("DRY_RUN") ||
    u.includes("_DEBUG") ||
    u.includes("_VERBOSE") ||
    u.includes("AUTO_") ||
    u.includes("FORCE_") ||
    u.includes("DISABLE_") ||
    u.includes("SHOULD_") ||
    u.endsWith("_SSL")
  );
}

function isNumberKey(key) {
  const u = key.toUpperCase();
  return (
    u.endsWith("_PORT") ||
    u.endsWith("_INTERVAL") ||
    u.endsWith("_TIMEOUT") ||
    u.endsWith("_MS") ||
    u.endsWith("_MINUTES") ||
    u.endsWith("_SECONDS") ||
    u.endsWith("_LIMIT") ||
    u.endsWith("_MAX") ||
    u.endsWith("_MIN") ||
    u.includes("_MAX_") ||
    u.includes("_MIN_") ||
    u.endsWith("_COUNT") ||
    u.endsWith("_SIZE") ||
    u.endsWith("_STEPS")
  );
}

function prefixLabel(key, suffix) {
  const raw = key.replace(new RegExp(`${suffix}$`, "i"), "").replace(/_+$/, "");
  if (!raw) return key;
  return raw
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function inferKeyDescription(key) {
  const u = key.toUpperCase();
  if (u.endsWith("_API_KEY"))
    return `API key for ${prefixLabel(key, "_API_KEY")}`;
  if (u.endsWith("_BOT_TOKEN"))
    return `Bot token for ${prefixLabel(key, "_BOT_TOKEN")}`;
  if (u.endsWith("_TOKEN"))
    return `Authentication token for ${prefixLabel(key, "_TOKEN")}`;
  if (u.endsWith("_SECRET")) return `Secret for ${prefixLabel(key, "_SECRET")}`;
  if (u.endsWith("_PRIVATE_KEY"))
    return `Private key for ${prefixLabel(key, "_PRIVATE_KEY")}`;
  if (u.endsWith("_PASSWORD"))
    return `Password for ${prefixLabel(key, "_PASSWORD")}`;
  if (u.endsWith("_RPC_URL"))
    return `RPC endpoint URL for ${prefixLabel(key, "_RPC_URL")}`;
  if (u.endsWith("_BASE_URL"))
    return `Base URL for ${prefixLabel(key, "_BASE_URL")}`;
  if (u.endsWith("_URL")) return `URL for ${prefixLabel(key, "_URL")}`;
  if (u.endsWith("_ENDPOINT"))
    return `Endpoint for ${prefixLabel(key, "_ENDPOINT")}`;
  if (u.endsWith("_HOST"))
    return `Host address for ${prefixLabel(key, "_HOST")}`;
  if (u.endsWith("_PORT"))
    return `Port number for ${prefixLabel(key, "_PORT")}`;
  if (u.endsWith("_MODEL") || u.includes("_MODEL_"))
    return `Model identifier for ${prefixLabel(key, "_MODEL")}`;
  if (u.endsWith("_VOICE") || u.includes("_VOICE_"))
    return `Voice setting for ${prefixLabel(key, "_VOICE")}`;
  if (u.endsWith("_DIR") || u.endsWith("_PATH")) return `Directory/file path`;
  if (u.endsWith("_ENABLED") || u.startsWith("ENABLE_"))
    return `Enable or disable this feature`;
  if (u.includes("DRY_RUN")) return `Dry-run mode (no real actions)`;
  if (u.endsWith("_INTERVAL") || u.endsWith("_INTERVAL_MINUTES"))
    return `Check interval`;
  if (u.endsWith("_TIMEOUT") || u.endsWith("_TIMEOUT_MS"))
    return `Timeout setting`;
  return key
    .split("_")
    .map((w, i) =>
      i === 0
        ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
        : w.toLowerCase(),
    )
    .join(" ");
}

/** Generate pluginParameters object from a list of config key names. */
function inferPluginParameters(configKeys) {
  const params = {};
  for (const key of configKeys) {
    const sensitive = isSensitiveKey(key);
    const type = isBooleanKey(key)
      ? "boolean"
      : isNumberKey(key)
        ? "number"
        : "string";
    // Do not infer required=true from _API_KEY — many plugins expose optional
    // third-party enrichers (e.g. music metadata) where any subset may be set.
    const required =
      sensitive &&
      (key.toUpperCase().endsWith("_BOT_TOKEN") ||
        key.toUpperCase().endsWith("_TOKEN") ||
        key.toUpperCase().endsWith("_PRIVATE_KEY"));
    params[key] = {
      type,
      description: inferKeyDescription(key),
      required,
      sensitive,
    };
  }
  return params;
}

// ---------------------------------------------------------------------------
// Load existing manifest for merge (preserves hand-authored data)
// ---------------------------------------------------------------------------

const existingManifest = new Map();
if (fs.existsSync(outputPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    if (Array.isArray(existing.plugins)) {
      for (const p of existing.plugins) {
        existingManifest.set(p.id, p);
      }
    }
  } catch {
    /* ignore read errors */
  }
}

// ---------------------------------------------------------------------------
// Fetch from registry
// ---------------------------------------------------------------------------

async function fetchRegistry() {
  console.log(`Fetching plugin registry from ${GENERATED_REGISTRY_URL}...`);

  const response = await fetch(GENERATED_REGISTRY_URL);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch registry: ${response.status} ${response.statusText}`,
    );
  }

  const registry = await response.json();
  return registry;
}

async function main() {
  let registry;
  try {
    registry = await fetchRegistry();
  } catch (err) {
    console.error(`Error fetching registry: ${err.message}`);
    console.log("Keeping existing plugins.json");
    process.exit(0);
  }

  const entries = [];

  // Registry format: { registry: { "@elizaos/plugin-xxx": { ... } } }
  const packages = registry.registry || {};
  const publishedPackageMetadata = await fetchPublishedPackageManifestMap(
    Object.entries(packages)
      .filter(
        ([npmName, pkgInfo]) =>
          npmName.startsWith("@elizaos/plugin-") &&
          pkgInfo.supports?.v2 &&
          !NATIVE_RUNTIME_FEATURE_PLUGIN_IDS.has(
            npmName.replace("@elizaos/plugin-", ""),
          ) &&
          !BUILT_IN_ADVANCED_CAPABILITY_PLUGIN_IDS.has(
            npmName.replace("@elizaos/plugin-", ""),
          ),
      )
      .map(([npmName, pkgInfo]) => ({
        name: npmName,
        version: pkgInfo.npm?.v2,
      })),
  );

  for (const [npmName, pkgInfo] of Object.entries(packages)) {
    // Only process @elizaos/plugin-* packages
    if (!npmName.startsWith("@elizaos/plugin-")) continue;

    // Skip if no v2 support (we're using next/alpha versions)
    if (!pkgInfo.supports?.v2) continue;

    const id = npmName.replace("@elizaos/plugin-", "");
    if (NATIVE_RUNTIME_FEATURE_PLUGIN_IDS.has(id)) continue;
    const isBuiltInAdvancedCapability =
      BUILT_IN_ADVANCED_CAPABILITY_PLUGIN_IDS.has(id);
    const dirName = isBuiltInAdvancedCapability ? undefined : `plugin-${id}`;
    // Use v2 npm version (next/alpha)
    const version = pkgInfo.npm?.v2 || undefined;

    // Get existing entry to preserve hand-authored metadata
    const existingEntry = existingManifest.get(id);
    const localMeta = dirName ? readLocalPackageMetadata(dirName, npmName) : {};
    const override = metadataOverrides[id] ?? {};
    const publishedMeta = isBuiltInAdvancedCapability
      ? {}
      : (publishedPackageMetadata.get(npmName) ?? {});

    // Preserve existing category if the inferred one is just "feature" (default)
    const inferredCategory = categorize(id);
    const category =
      inferredCategory === "feature" && existingEntry?.category
        ? existingEntry.category
        : inferredCategory;
    const name = existingEntry?.name || formatName(id);
    const description =
      override.description ||
      pkgInfo.description ||
      localMeta.description ||
      publishedMeta.description ||
      existingEntry?.description ||
      inferDescription(id, name, category);
    const tags = mergeTags(
      override.tags,
      localMeta.tags,
      pkgInfo.topics,
      publishedMeta.tags,
      CATEGORY_TAGS[category] ?? [],
      category === "connector" ? connectorTags(id) : [],
      idTags(id),
      existingEntry?.tags,
    );

    // Preserve existing manifest config when present, otherwise hydrate from
    // local or published package metadata.
    const configKeys =
      existingEntry?.configKeys?.length > 0
        ? existingEntry.configKeys
        : localMeta.configKeys?.length > 0
          ? localMeta.configKeys
          : (publishedMeta.configKeys ?? []);
    const envKey = findEnvKey(configKeys);

    // Preserve pluginDeps from existing manifest
    const pluginDeps = existingEntry?.pluginDeps;

    // Preserve pluginParameters from existing manifest when present, otherwise
    // hydrate them from package metadata before falling back to key inference.
    let finalPluginParams =
      existingEntry?.pluginParameters &&
      Object.keys(existingEntry.pluginParameters).length > 0
        ? existingEntry.pluginParameters
        : localMeta.pluginParameters || publishedMeta.pluginParameters;
    if (!finalPluginParams && configKeys.length > 0) {
      finalPluginParams = inferPluginParameters(configKeys);
    }

    entries.push({
      id,
      ...(dirName ? { dirName } : {}),
      name,
      ...(isBuiltInAdvancedCapability ? {} : { npmName }),
      description,
      tags,
      category,
      envKey,
      configKeys,
      version: version || undefined,
      pluginDeps: pluginDeps?.length > 0 ? pluginDeps : undefined,
      pluginParameters: finalPluginParams,
      ...(existingEntry?.configUiHints ||
      localMeta.configUiHints ||
      publishedMeta.configUiHints
        ? {
            configUiHints:
              existingEntry?.configUiHints ||
              localMeta.configUiHints ||
              publishedMeta.configUiHints,
          }
        : {}),
      ...(pkgInfo.homepage ||
      existingEntry?.homepage ||
      localMeta.homepage ||
      publishedMeta.homepage
        ? {
            homepage:
              pkgInfo.homepage ||
              existingEntry?.homepage ||
              localMeta.homepage ||
              publishedMeta.homepage,
          }
        : {}),
      ...(() => {
        const repository =
          normalizeRepositoryUrl(
            pkgInfo.gitRepo ? `https://github.com/${pkgInfo.gitRepo}` : "",
          ) ??
          existingEntry?.repository ??
          localMeta.repository ??
          publishedMeta.repository;
        return repository ? { repository } : {};
      })(),
      ...(() => {
        const setupGuideUrl =
          resolveSetupGuideUrl(id) ?? existingEntry?.setupGuideUrl;
        return setupGuideUrl ? { setupGuideUrl } : {};
      })(),
      ...(existingEntry?.icon || localMeta.icon || publishedMeta.icon
        ? { icon: existingEntry?.icon ?? localMeta.icon ?? publishedMeta.icon }
        : {}),
    });
  }

  // Vendored @elizaos plugins not yet in elizaos-plugins/registry.
  const localAdditionsPath = path.join(
    __dirname,
    "plugin-index-local-additions.json",
  );
  if (fs.existsSync(localAdditionsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(localAdditionsPath, "utf8"));
      const list = Array.isArray(raw) ? raw : raw.plugins || [];
      for (const base of list) {
        if (!base?.id || entries.some((e) => e.id === base.id)) continue;
        const id = base.id;
        if (NATIVE_RUNTIME_FEATURE_PLUGIN_IDS.has(id)) continue;
        const dirName = base.dirName || `plugin-${id}`;
        const npmName = base.npmName || `@elizaos/plugin-${id}`;
        const localMeta = readLocalPackageMetadata(dirName, npmName);
        const override = metadataOverrides[id] ?? {};
        const inferredCategory = categorize(id);
        const category =
          inferredCategory === "feature" && base.category
            ? base.category
            : inferredCategory;
        const configKeys =
          Array.isArray(override.configKeys) && override.configKeys.length > 0
            ? override.configKeys
            : Array.isArray(base.configKeys)
              ? base.configKeys
              : [];
        const envKey =
          typeof base.envKey === "string"
            ? base.envKey
            : findEnvKey(configKeys);
        const description =
          override.description ||
          localMeta.description ||
          base.description ||
          inferDescription(id, base.name || formatName(id), category);
        const tags = mergeTags(
          override.tags,
          localMeta.tags,
          CATEGORY_TAGS[category] ?? [],
          category === "connector" ? connectorTags(id) : [],
          idTags(id),
          base.tags,
        );
        let finalPluginParams = base.pluginParameters;
        if (!finalPluginParams && configKeys.length > 0) {
          finalPluginParams = inferPluginParameters(configKeys);
        }
        entries.push({
          id,
          dirName,
          name: base.name || formatName(id),
          npmName,
          description,
          tags,
          category,
          envKey,
          configKeys,
          version: base.version || undefined,
          pluginDeps:
            Array.isArray(base.pluginDeps) && base.pluginDeps.length > 0
              ? base.pluginDeps
              : undefined,
          pluginParameters: finalPluginParams,
          ...(base.repository || localMeta.repository
            ? { repository: base.repository ?? localMeta.repository }
            : {}),
          ...(base.homepage || localMeta.homepage
            ? { homepage: base.homepage ?? localMeta.homepage }
            : {}),
        });
      }
    } catch (err) {
      console.warn(`[generate-plugin-index] local additions: ${err.message}`);
    }
  }

  for (const [id, existingEntry] of existingManifest.entries()) {
    if (entries.some((entry) => entry.id === id)) continue;
    if (NATIVE_RUNTIME_FEATURE_PLUGIN_IDS.has(id)) continue;

    const dirName = existingEntry.dirName || `plugin-${id}`;
    const npmName = existingEntry.npmName;
    const localMeta = readLocalPackageMetadata(dirName, npmName);
    const override = metadataOverrides[id] ?? {};
    const inferredCategory = categorize(id);
    const category =
      inferredCategory === "feature" && existingEntry?.category
        ? existingEntry.category
        : inferredCategory;
    const repository =
      existingEntry.repository ?? localMeta.repository ?? undefined;
    const homepage = existingEntry.homepage ?? localMeta.homepage ?? undefined;
    const setupGuideUrl =
      existingEntry.setupGuideUrl ?? resolveSetupGuideUrl(id) ?? undefined;
    const tags = mergeTags(
      override.tags,
      localMeta.tags,
      CATEGORY_TAGS[category] ?? [],
      category === "connector" ? connectorTags(id) : [],
      idTags(id),
      existingEntry.tags,
    );
    const description =
      override.description ||
      existingEntry.description ||
      localMeta.description ||
      inferDescription(id, existingEntry.name || formatName(id), category);

    entries.push({
      ...existingEntry,
      id,
      dirName,
      description,
      tags,
      category,
      ...(repository ? { repository } : {}),
      ...(homepage ? { homepage } : {}),
      ...(setupGuideUrl ? { setupGuideUrl } : {}),
      ...(existingEntry.icon || localMeta.icon
        ? { icon: existingEntry.icon ?? localMeta.icon }
        : {}),
    });
  }

  // Sort by id
  entries.sort((a, b) => a.id.localeCompare(b.id));

  // ---------------------------------------------------------------------------
  // Write output
  // ---------------------------------------------------------------------------

  const manifest = {
    $schema: "plugin-index-v1",
    generatedAt: new Date().toISOString(),
    count: entries.length,
    plugins: entries,
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Generated ${outputPath} (${entries.length} plugins)`);
}

function isDirectExecution() {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
