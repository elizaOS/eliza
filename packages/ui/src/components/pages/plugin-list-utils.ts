/**
 * Plugin list utilities — pure functions, constants, and type aliases
 * shared across the plugin management UI.
 */

import type { LucideIcon } from "lucide-react";
import {
  Binary,
  Bird,
  BookOpen,
  Bot,
  Brain,
  BrickWall,
  Briefcase,
  Calendar,
  Circle,
  CircleDashed,
  CircleDot,
  ClipboardList,
  Clock,
  Cloud,
  Command,
  Construction,
  CreditCard,
  Diamond,
  Dna,
  Eye,
  Feather,
  FileKey,
  FileText,
  Fingerprint,
  Gamepad,
  Gamepad2,
  GitBranch,
  Globe,
  Handshake,
  Hash,
  Layers,
  Leaf,
  Link,
  Lock,
  LockKeyhole,
  Mail,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Mic,
  Monitor,
  MousePointer2,
  Package,
  PenTool,
  Phone,
  Pickaxe,
  Puzzle,
  RefreshCw,
  Rss,
  ScrollText,
  Send,
  Server,
  Settings,
  Shell,
  Shuffle,
  Smartphone,
  Sparkle,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Target,
  Tornado,
  TrendingDown,
  Triangle,
  Video,
  Volume2,
  Wallet,
  Webhook,
  Wrench,
  Zap,
} from "lucide-react";
import type { PluginInfo, PluginParamDef } from "../../api";
import type { JsonSchemaObject } from "../../config/config-catalog";
import type { TranslateFn as AppTranslateFn, ConfigUiHint } from "../../types";
import { resolveAppAssetUrl } from "../../utils";
import { autoLabel } from "../../utils/labels";
import { SHOWCASE_PLUGIN } from "../plugins/showcase-data";

const DISCORD_DEVELOPER_PORTAL_URL =
  "https://discord.com/developers/applications";
const DISCORD_INVITE_PERMISSIONS = "67193856";
const DISCORD_INVITE_SCOPES = "bot applications.commands";

/* ── Always-on plugins (hidden from all views) ────────────────────────── */

/**
 * Plugin IDs hidden from Features/Connectors views.
 * Core plugins are visible in Admin > Plugins instead.
 */
export const ALWAYS_ON_PLUGIN_IDS = new Set([
  // Core (always loaded)
  "sql",
  "local-embedding",
  "documents",
  "agent-skills",
  "directives",
  "commands",
  "personality",
  "experience",
  // Optional core (shown in admin)
  "agent-orchestrator",
  "shell",
  "plugin-manager",
  "cli",
  "code",
  "edge-tts",
  "pdf",
  "clipboard",
  "todo",
  "trust",
  "form",
  "goals",
  "scheduling",
  // Internal / infrastructure
  "elizacloud",
  "evm",
  "memory",
  "relationships",
  "tts",
  "elevenlabs",
  "cron",
  "webhooks",
  "browser",
  "vision",
  "computeruse",
]);

/** Keys to hide when Telegram "Allow all chats" mode is active. */
export const TELEGRAM_ALLOW_ALL_HIDDEN = new Set(["TELEGRAM_ALLOWED_CHATS"]);

/* ── Helpers ────────────────────────────────────────────────────────── */

/** Detect advanced / debug parameters that should be collapsed by default. */
export function isAdvancedParam(param: PluginParamDef): boolean {
  const k = param.key.toUpperCase();
  const d = (param.description ?? "").toLowerCase();
  return (
    k.includes("EXPERIMENTAL") ||
    k.includes("DEBUG") ||
    k.includes("VERBOSE") ||
    k.includes("TELEMETRY") ||
    k.includes("BROWSER_BASE") ||
    d.includes("experimental") ||
    d.includes("advanced") ||
    d.includes("debug")
  );
}

/** Convert PluginParamDef[] to a JSON Schema + ConfigUiHints for ConfigRenderer. */
export function paramsToSchema(
  params: PluginParamDef[],
  pluginId: string,
): {
  schema: JsonSchemaObject;
  hints: Record<string, ConfigUiHint>;
} {
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const hints: Record<string, ConfigUiHint> = {};

  for (const p of params) {
    // Build JSON Schema property
    const prop: Record<string, unknown> = {};
    if (p.type === "boolean") {
      prop.type = "boolean";
    } else if (p.type === "number") {
      prop.type = "number";
    } else {
      prop.type = "string";
    }
    if (p.description) prop.description = p.description;
    if (p.default != null) prop.default = p.default;
    if (p.options?.length) {
      prop.enum = p.options;
    }

    // Auto-detect format from key name
    const keyUpper = p.key.toUpperCase();
    if (
      keyUpper.includes("URL") ||
      keyUpper.includes("ENDPOINT") ||
      keyUpper.includes("BASE_URL")
    ) {
      prop.format = "uri";
    } else if (keyUpper.includes("EMAIL")) {
      prop.format = "email";
    } else if (
      keyUpper.includes("_DATE") ||
      keyUpper.includes("_SINCE") ||
      keyUpper.includes("_UNTIL")
    ) {
      prop.format = "date";
    }

    // Auto-detect number types from key patterns
    if (keyUpper.includes("PORT") && prop.type === "string") {
      prop.type = "number";
    } else if (
      (keyUpper.includes("TIMEOUT") ||
        keyUpper.includes("INTERVAL") ||
        keyUpper.includes("_MS")) &&
      prop.type === "string"
    ) {
      prop.type = "number";
    } else if (
      (keyUpper.includes("COUNT") ||
        keyUpper.includes("LIMIT") ||
        keyUpper.startsWith("MAX_")) &&
      prop.type === "string"
    ) {
      prop.type = "number";
    } else if (
      (keyUpper.includes("RETRY") || keyUpper.includes("RETRIES")) &&
      prop.type === "string"
    ) {
      prop.type = "number";
    }

    // Auto-detect boolean from key patterns
    if (
      prop.type === "string" &&
      (keyUpper.includes("SHOULD_") ||
        keyUpper.endsWith("_ENABLED") ||
        keyUpper.endsWith("_DISABLED") ||
        keyUpper.startsWith("USE_") ||
        keyUpper.startsWith("ALLOW_") ||
        keyUpper.startsWith("IS_") ||
        keyUpper.startsWith("ENABLE_") ||
        keyUpper.startsWith("DISABLE_") ||
        keyUpper.startsWith("FORCE_") ||
        keyUpper.endsWith("_AUTONOMOUS_MODE"))
    ) {
      prop.type = "boolean";
    }

    // Auto-detect number from key patterns (RATE, DELAY, THRESHOLD, SIZE, TEMPERATURE)
    if (
      prop.type === "string" &&
      (keyUpper.includes("_RATE") ||
        keyUpper.includes("DELAY") ||
        keyUpper.includes("THRESHOLD") ||
        keyUpper.includes("_SIZE") ||
        keyUpper.includes("TEMPERATURE") ||
        keyUpper.includes("_DEPTH") ||
        keyUpper.includes("_PERCENT") ||
        keyUpper.includes("_RATIO"))
    ) {
      prop.type = "number";
    }

    // Auto-detect comma-separated lists → array renderer
    if (prop.type === "string" && !prop.enum) {
      const descLower = (p.description || "").toLowerCase();
      const isCommaSep =
        descLower.includes("comma-separated") ||
        descLower.includes("comma separated");
      const isListSuffix =
        keyUpper.endsWith("_IDS") ||
        keyUpper.endsWith("_CHANNELS") ||
        keyUpper.endsWith("_ROOMS") ||
        keyUpper.endsWith("_RELAYS") ||
        keyUpper.endsWith("_FEEDS") ||
        keyUpper.endsWith("_DEXES") ||
        keyUpper.endsWith("_WHITELIST") ||
        keyUpper.endsWith("_BLACKLIST") ||
        keyUpper.endsWith("_ALLOWLIST") ||
        keyUpper.endsWith("_SPACES") ||
        keyUpper.endsWith("_THREADS") ||
        keyUpper.endsWith("_ROLES") ||
        keyUpper.endsWith("_TENANTS") ||
        keyUpper.endsWith("_DIRS");
      if (isCommaSep || isListSuffix) {
        prop.type = "array";
        prop.items = { type: "string" };
      }
    }

    // Auto-detect textarea (prompts, instructions, templates, greetings)
    if (prop.type === "string" && !prop.enum && !keyUpper.includes("MODEL")) {
      if (
        keyUpper.includes("INSTRUCTIONS") ||
        keyUpper.includes("_GREETING") ||
        keyUpper.endsWith("_PROMPT") ||
        keyUpper.endsWith("_TEMPLATE") ||
        keyUpper.includes("SYSTEM_MESSAGE")
      ) {
        prop.maxLength = 999;
      }
    }

    // Auto-detect JSON fields (json-encoded or serialized values)
    if (prop.type === "string" && !p.sensitive) {
      const descLower = (p.description || "").toLowerCase();
      if (
        descLower.includes("json-encoded") ||
        descLower.includes("json array") ||
        descLower.includes("serialized") ||
        descLower.includes("json format")
      ) {
        (prop as Record<string, unknown>).__jsonHint = true;
      }
    }

    // Auto-detect file/directory paths → file renderer
    if (prop.type === "string") {
      if (
        (keyUpper.endsWith("_PATH") && !keyUpper.includes("WEBHOOK")) ||
        keyUpper.endsWith("_DIR") ||
        keyUpper.endsWith("_DIRECTORY") ||
        keyUpper.endsWith("_FOLDER") ||
        keyUpper.endsWith("_FILE")
      ) {
        (prop as Record<string, unknown>).__fileHint = true;
      }
    }

    // Auto-detect textarea from long descriptions
    if (p.description && p.description.length > 200) {
      prop.maxLength = 999;
    }

    properties[p.key] = prop;

    if (p.required) required.push(p.key);

    // Build UI hint
    const hint: ConfigUiHint = {
      label: autoLabel(p.key, pluginId),
      sensitive: p.sensitive ?? false,
      advanced: isAdvancedParam(p),
    };

    // Port numbers — constrain range
    if (keyUpper.includes("PORT")) {
      hint.min = 1;
      hint.max = 65535;
      prop.minimum = 1;
      prop.maximum = 65535;
    }

    // Timeout/interval — show unit
    if (
      keyUpper.includes("TIMEOUT") ||
      keyUpper.includes("INTERVAL") ||
      keyUpper.includes("_MS")
    ) {
      hint.unit = "ms";
      prop.minimum = 0;
      hint.min = 0;
    }

    // Count/limit — non-negative
    if (
      keyUpper.includes("COUNT") ||
      keyUpper.includes("LIMIT") ||
      keyUpper.startsWith("MAX_")
    ) {
      hint.min = 0;
      prop.minimum = 0;
    }

    // Retry — bounded range
    if (keyUpper.includes("RETRY") || keyUpper.includes("RETRIES")) {
      hint.min = 0;
      hint.max = 100;
      prop.minimum = 0;
      prop.maximum = 100;
    }

    // Debug/verbose/enabled — mark as advanced
    if (
      keyUpper.includes("DEBUG") ||
      keyUpper.includes("VERBOSE") ||
      keyUpper.includes("ENABLED")
    ) {
      hint.advanced = true;
    }

    // Model selection — NOT advanced (important user-facing choice)
    if (keyUpper.includes("MODEL") && p.options?.length) {
      hint.advanced = false;
    }

    // Region/zone — suggest common cloud regions when no options provided
    if (
      (keyUpper.includes("REGION") || keyUpper.includes("ZONE")) &&
      !p.options?.length
    ) {
      hint.type = "select";
      hint.options = [
        { value: "us-east-1", label: "US East (N. Virginia)" },
        { value: "us-west-2", label: "US West (Oregon)" },
        { value: "eu-west-1", label: "EU (Ireland)" },
        { value: "eu-central-1", label: "EU (Frankfurt)" },
        { value: "ap-southeast-1", label: "Asia Pacific (Singapore)" },
        { value: "ap-northeast-1", label: "Asia Pacific (Tokyo)" },
      ];
    }

    // File/directory path → file renderer
    if ((prop as Record<string, unknown>).__fileHint) {
      hint.type = "file";
      delete (prop as Record<string, unknown>).__fileHint;
    }

    // JSON-encoded value → json renderer
    if ((prop as Record<string, unknown>).__jsonHint) {
      hint.type = "json";
      delete (prop as Record<string, unknown>).__jsonHint;
    }

    // Model name fields — helpful placeholder (overridden by server-provided model options via configUiHints)
    if (
      keyUpper.includes("MODEL") &&
      prop.type === "string" &&
      !p.options?.length
    ) {
      if (!hint.placeholder) {
        if (keyUpper.includes("EMBEDDING")) {
          hint.placeholder = "e.g., text-embedding-3-small";
        } else if (keyUpper.includes("TTS")) {
          hint.placeholder = "e.g., tts-1, eleven_multilingual_v2";
        } else if (keyUpper.includes("STT")) {
          hint.placeholder = "e.g., whisper-1";
        } else if (keyUpper.includes("IMAGE")) {
          hint.placeholder = "e.g., dall-e-3, gpt-4o";
        } else {
          hint.placeholder = "e.g., gpt-4o, claude-sonnet-4-6";
        }
      }
    }

    // Mode/strategy fields — extract options from description if available
    if (
      prop.type === "string" &&
      !prop.enum &&
      !p.sensitive &&
      (keyUpper.endsWith("_MODE") || keyUpper.endsWith("_STRATEGY"))
    ) {
      const desc = p.description ?? "";
      // Match "auto | local | mcp" or "filesystem|in-context|sqlite"
      const pipeMatch =
        desc.match(/:\s*([a-z0-9_-]+(?:\s*[|/]\s*[a-z0-9_-]+)+)/i) ??
        desc.match(/\(([a-z0-9_-]+(?:\s*[|/,]\s*[a-z0-9_-]+)+)\)/i);
      if (pipeMatch) {
        const opts = pipeMatch[1]
          .split(/[|/,]/)
          .map((s) => s.trim())
          .filter(Boolean);
        const safeOpts = opts.filter((v) => /^[a-z0-9_-]+$/i.test(v));
        if (safeOpts.length >= 2 && safeOpts.length <= 10) {
          hint.type = "select";
          hint.options = safeOpts.map((v) => ({ value: v, label: v }));
        }
      } else {
        // Match 'polling' or 'webhook' -or- 'env', 'oauth', or 'bearer' style
        const quotedOpts = [...desc.matchAll(/'([a-z0-9_-]+)'/gi)].map(
          (m) => m[1],
        );
        const safeQuoted = quotedOpts.filter((v) => /^[a-z0-9_-]+$/i.test(v));
        if (safeQuoted.length >= 2 && safeQuoted.length <= 10) {
          // Radio for 2 options, select for 3+
          hint.type = safeQuoted.length === 2 ? "radio" : "select";
          hint.options = safeQuoted.map((v) => ({ value: v, label: v }));
        }
      }
    }

    if (p.description) {
      hint.help = p.description;
      if (p.default != null) hint.help += ` (default: ${String(p.default)})`;
    }
    if (p.sensitive)
      hint.placeholder = p.isSet ? "********  (already set)" : "Enter value...";
    else if (p.default) hint.placeholder = `Default: ${String(p.default)}`;
    hints[p.key] = hint;
  }

  return {
    schema: { type: "object", properties, required } as JsonSchemaObject,
    hints,
  };
}

/* ── Icon Lookup ───────────────────────────────────────────────────── */

/**
 * Lucide name → component map. Entries declare their icon by Lucide
 * component name in `render.icon` (PluginInfo.iconName); this map resolves
 * that name to the actual React component at render time.
 */
const ICON_BY_LUCIDE_NAME: Record<string, LucideIcon> = {
  Binary,
  Bird,
  BookOpen,
  Bot,
  Brain,
  BrickWall,
  Briefcase,
  Calendar,
  Chrome: Globe,
  Circle,
  CircleDashed,
  CircleDot,
  ClipboardList,
  Clock,
  Cloud,
  Command,
  Construction,
  CreditCard,
  Diamond,
  Dna,
  Eye,
  Feather,
  FileKey,
  FileText,
  Fingerprint,
  Gamepad,
  Gamepad2,
  GitBranch,
  Github: GitBranch,
  Globe,
  Handshake,
  Hash,
  Layers,
  Leaf,
  Link,
  Lock,
  LockKeyhole,
  Mail,
  MessageCircle,
  MessageSquare,
  MessagesSquare,
  Mic,
  Monitor,
  MousePointer2,
  Package,
  PenTool,
  Phone,
  Pickaxe,
  Puzzle,
  RefreshCw,
  Rss,
  ScrollText,
  Send,
  Server,
  Settings,
  Shell,
  Shuffle,
  Smartphone,
  Sparkle,
  Sparkles,
  Square,
  Star,
  StickyNote,
  Target,
  Tornado,
  TrendingDown,
  Triangle,
  Twitter: MessageCircle,
  Video,
  Volume2,
  Wallet,
  Webhook,
  Wrench,
  Zap,
};

/** Resolve display icon. Order: explicit URL/emoji on PluginInfo.icon →
 *  registry-provided Lucide name (PluginInfo.iconName) → null. */
export function resolveIcon(p: PluginInfo): LucideIcon | string | null {
  if (p.icon) return p.icon;
  if (p.iconName) return ICON_BY_LUCIDE_NAME[p.iconName] ?? null;
  return null;
}

export function iconImageSource(icon: string): string | null {
  const value = icon.trim();
  if (!value) return null;
  if (
    /^(https?:|data:image\/|blob:|file:|capacitor:|electrobun:|app:|\/|\.\/|\.\.\/)/i.test(
      value,
    )
  ) {
    return resolveAppAssetUrl(value);
  }
  return null;
}

export type TranslateFn = AppTranslateFn;

function resolvePluginParamValue(
  plugin: Pick<PluginInfo, "parameters">,
  key: string,
  draftConfig?: Record<string, string>,
): string | null {
  const draftValue = draftConfig?.[key]?.trim();
  if (draftValue) {
    return draftValue;
  }

  const param = plugin.parameters?.find((candidate) => candidate.key === key);
  if (!param || param.sensitive || !param.isSet) {
    return null;
  }

  const persistedValue = param.currentValue?.trim();
  return persistedValue ? persistedValue : null;
}

export function buildDiscordInviteUrl(applicationId: string): string {
  const params = new URLSearchParams({
    client_id: applicationId,
    permissions: DISCORD_INVITE_PERMISSIONS,
    scope: DISCORD_INVITE_SCOPES,
  });
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function getPluginResourceLinks(
  plugin: Pick<
    PluginInfo,
    "id" | "homepage" | "parameters" | "repository" | "setupGuideUrl"
  >,
  options?: {
    draftConfig?: Record<string, string>;
  },
): Array<{ key: string; url: string }> {
  const seen = new Set<string>();
  const ordered: Array<{ key: string; url?: string | null }> = [];

  if (plugin.id === "discord") {
    ordered.push({
      key: "discord-developer-portal",
      url: DISCORD_DEVELOPER_PORTAL_URL,
    });

    const applicationId = resolvePluginParamValue(
      plugin,
      "DISCORD_APPLICATION_ID",
      options?.draftConfig,
    );
    if (applicationId && /^\d+$/.test(applicationId)) {
      ordered.push({
        key: "discord-invite",
        url: buildDiscordInviteUrl(applicationId),
      });
    }
  }

  ordered.push(
    { key: "guide", url: plugin.setupGuideUrl },
    { key: "official", url: plugin.homepage },
    { key: "source", url: plugin.repository },
  );

  return ordered.flatMap((item) => {
    const url = item.url?.trim();
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ key: item.key, url }];
  });
}

export function pluginResourceLinkLabel(t: TranslateFn, key: string): string {
  if (key === "discord-developer-portal") {
    return t("pluginsview.DiscordDeveloperPortal", {
      defaultValue: "Get your API token here",
    });
  }
  if (key === "discord-invite") {
    return t("pluginsview.DiscordInviteBot", {
      defaultValue: "Invite your agent",
    });
  }
  if (key === "guide") {
    return t("pluginsview.SetupGuide", { defaultValue: "Setup guide" });
  }
  if (key === "official") {
    return t("pluginsview.Official", { defaultValue: "Official" });
  }
  return t("logsview.Source", { defaultValue: "Source" });
}

/* ── Sub-group Classification ──────────────────────────────────────── */

// Per-plugin sub-group assignment lives in the registry as `render.group`.
// This file used to mirror it as a hardcoded FEATURE_SUBGROUP map; that
// duplication is gone. The order/labels/nav-icons below are GROUP-level
// metadata that the per-entry registry does not (yet) model.

export const SUBGROUP_DISPLAY_ORDER = [
  "ai-provider",
  "connector",
  "streaming",
  "voice",
  "blockchain",
  "devtools",
  "documents",
  "agents",
  "media",
  "automation",
  "storage",
  "gaming",
  "feature-other",
  "showcase",
] as const;

export const SUBGROUP_LABELS: Record<string, string> = {
  "ai-provider": "AI Providers",
  connector: "Connectors",
  voice: "Voice & Audio",
  blockchain: "Blockchain & Finance",
  devtools: "Dev Tools & Infrastructure",
  documents: "Knowledge & Memory",
  agents: "Agents & Orchestration",
  media: "Media & Content",
  automation: "Scheduling & Automation",
  storage: "Storage & Logging",
  gaming: "Gaming & Creative",
  "feature-other": "Other Features",
  streaming: "Streaming Destinations",
  showcase: "Showcase",
};

export const SUBGROUP_NAV_ICONS: Record<string, LucideIcon> = {
  all: Package,
  "ai-provider": Brain,
  connector: MessageCircle,
  streaming: Video,
  voice: Mic,
  blockchain: Wallet,
  devtools: Shell,
  documents: BookOpen,
  agents: Target,
  media: Eye,
  automation: Calendar,
  storage: Server,
  gaming: Gamepad2,
  "feature-other": Puzzle,
  showcase: Sparkles,
};

export function subgroupForPlugin(plugin: PluginInfo): string {
  if (plugin.id === "__ui-showcase__") return "showcase";
  if (plugin.group) return plugin.group;
  // Defensive fallback for runtime-discovered plugins not in the registry.
  if (plugin.category === "ai-provider") return "ai-provider";
  if (plugin.category === "connector") return "connector";
  if (plugin.category === "streaming") return "streaming";
  return "feature-other";
}

export type StatusFilter = "all" | "enabled" | "disabled";
export type PluginsViewMode =
  | "all"
  | "all-social"
  | "connectors"
  | "streaming"
  | "social";
export type SubgroupTag = { id: string; label: string; count: number };

export function isPluginReady(plugin: PluginInfo): boolean {
  if (!plugin.enabled) return false;
  const needsConfig =
    plugin.parameters?.some(
      (param: PluginParamDef) => param.required && !param.isSet,
    ) ?? false;
  return !needsConfig;
}

export function comparePlugins(left: PluginInfo, right: PluginInfo): number {
  // Ready plugins (enabled + fully configured) float to the top
  const leftReady = isPluginReady(left);
  const rightReady = isPluginReady(right);
  if (leftReady !== rightReady) return leftReady ? -1 : 1;
  // Then enabled-but-needs-config
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  return (left.name ?? "").localeCompare(right.name ?? "");
}

export function matchesPluginFilters(
  plugin: PluginInfo,
  searchLower: string,
  statusFilter: StatusFilter,
): boolean {
  const matchesStatus =
    statusFilter === "all" ||
    (statusFilter === "enabled" && plugin.enabled) ||
    (statusFilter === "disabled" && !plugin.enabled);
  const matchesSearch =
    !searchLower ||
    (plugin.name ?? "").toLowerCase().includes(searchLower) ||
    (plugin.description ?? "").toLowerCase().includes(searchLower) ||
    (plugin.tags ?? []).some((tag) =>
      (tag ?? "").toLowerCase().includes(searchLower),
    ) ||
    plugin.id.toLowerCase().includes(searchLower);
  return matchesStatus && matchesSearch;
}

export function sortPlugins(
  filteredPlugins: PluginInfo[],
  pluginOrder: string[],
  allowCustomOrder: boolean,
): PluginInfo[] {
  if (!allowCustomOrder || pluginOrder.length === 0) {
    return [...filteredPlugins].sort(comparePlugins);
  }

  const orderMap = new Map(pluginOrder.map((id, index) => [id, index]));
  return [...filteredPlugins].sort((left, right) => {
    const leftIndex = orderMap.get(left.id);
    const rightIndex = orderMap.get(right.id);
    if (leftIndex != null && rightIndex != null) return leftIndex - rightIndex;
    if (leftIndex != null) return -1;
    if (rightIndex != null) return 1;
    return comparePlugins(left, right);
  });
}

export function buildPluginListState(options: {
  allowCustomOrder: boolean;
  effectiveSearch: string;
  effectiveStatusFilter: StatusFilter;
  isConnectorLikeMode: boolean;
  mode: PluginsViewMode;
  pluginOrder: string[];
  plugins: PluginInfo[];
  showSubgroupFilters: boolean;
  subgroupFilter: string;
}): {
  nonDbPlugins: PluginInfo[];
  sorted: PluginInfo[];
  subgroupTags: SubgroupTag[];
  visiblePlugins: PluginInfo[];
} {
  const {
    allowCustomOrder,
    effectiveSearch,
    effectiveStatusFilter,
    isConnectorLikeMode,
    mode,
    pluginOrder,
    plugins,
    showSubgroupFilters,
    subgroupFilter,
  } = options;
  const categoryPlugins = plugins.filter(
    (plugin) =>
      plugin.category !== "database" &&
      !ALWAYS_ON_PLUGIN_IDS.has(plugin.id) &&
      (!isConnectorLikeMode ||
        (plugin.category === "connector" && plugin.visible !== false)) &&
      (mode !== "streaming" || plugin.category === "streaming"),
  );
  const nonDbPlugins = [SHOWCASE_PLUGIN, ...categoryPlugins];
  const searchLower =
    typeof effectiveSearch === "string" ? effectiveSearch.toLowerCase() : "";
  const sorted = sortPlugins(
    categoryPlugins.filter((plugin) =>
      matchesPluginFilters(plugin, searchLower, effectiveStatusFilter),
    ),
    pluginOrder,
    allowCustomOrder,
  );
  const subgroupCounts: Record<string, number> = {};
  const visiblePlugins: PluginInfo[] = [];
  for (const plugin of sorted) {
    const subgroup = subgroupForPlugin(plugin);
    subgroupCounts[subgroup] = (subgroupCounts[subgroup] ?? 0) + 1;
    if (
      !showSubgroupFilters ||
      subgroupFilter === "all" ||
      subgroup === subgroupFilter
    ) {
      visiblePlugins.push(plugin);
    }
  }

  const subgroupTags = [
    { id: "all", label: "All", count: sorted.length },
    ...SUBGROUP_DISPLAY_ORDER.filter(
      (subgroupId) => (subgroupCounts[subgroupId] ?? 0) > 0,
    ).map((subgroupId) => ({
      id: subgroupId,
      label: SUBGROUP_LABELS[subgroupId],
      count: subgroupCounts[subgroupId] ?? 0,
    })),
  ];

  return {
    nonDbPlugins,
    sorted,
    subgroupTags,
    visiblePlugins,
  };
}
