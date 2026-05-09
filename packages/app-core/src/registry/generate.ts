// One-off migration: plugins.json -> per-entry registry JSON files.
//
// Run with: bun run packages/app-core/src/registry/generate.ts
//
// Reads the legacy plugins.json + applies the same heuristics that
// plugin-list-utils.ts applies at runtime (paramsToSchema, FEATURE_SUBGROUP,
// DEFAULT_ICONS, VISIBLE_CONNECTOR_IDS) and emits one JSON per entry under
// src/registry/entries/{apps,plugins,connectors}/<id>.json.
//
// Heuristics live ONLY here. Once the migration runs, edit the emitted JSON
// directly — the heuristics never run again.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ConfigField,
  type RegistryEntry,
  registryEntrySchema,
} from "./schema";

interface LegacyPluginParameter {
  type: string;
  description?: string;
  required?: boolean;
  sensitive?: boolean;
  default?: string | number | boolean;
}

interface LegacyPlugin {
  id: string;
  dirName?: string;
  name: string;
  npmName?: string;
  description?: string;
  tags?: string[];
  category:
    | "ai-provider"
    | "connector"
    | "streaming"
    | "database"
    | "app"
    | "feature";
  envKey?: string;
  configKeys?: string[];
  version?: string;
  pluginParameters?: Record<string, LegacyPluginParameter>;
  homepage?: string;
  repository?: string;
  setupGuideUrl?: string;
  icon?: string;
}

interface LegacyIndex {
  plugins: LegacyPlugin[];
}

// ---------------------------------------------------------------------------
// Lookup tables — copied verbatim from plugin-list-utils.ts so the migration
// is one self-contained script. After the migration, those constants get
// deleted and the JSON files become the source of truth.
// ---------------------------------------------------------------------------

const VISIBLE_CONNECTOR_IDS = new Set([
  "discord",
  "google-chat",
  "imessage",
  "msteams",
  "instagram",
  "line",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
  "wechat",
  "twitter",
]);

const FEATURE_SUBGROUP: Record<string, string> = {
  "edge-tts": "voice",
  elevenlabs: "voice",
  tts: "voice",
  "robot-voice": "voice",
  evm: "blockchain",
  solana: "blockchain",
  "auto-trader": "blockchain",
  "lp-manager": "blockchain",
  "social-alpha": "blockchain",
  polymarket: "blockchain",
  x402: "blockchain",
  trust: "blockchain",
  iq: "blockchain",
  cli: "devtools",
  code: "devtools",
  shell: "devtools",
  github: "devtools",
  linear: "devtools",
  mcp: "devtools",
  browser: "devtools",
  computeruse: "devtools",
  workflow: "devtools",
  webhooks: "devtools",
  memory: "documents",
  "local-embedding": "documents",
  pdf: "documents",
  clipboard: "documents",
  rlm: "documents",
  "agent-orchestrator": "agents",
  "agent-skills": "agents",
  "plugin-manager": "agents",
  "copilot-proxy": "agents",
  directives: "agents",
  goals: "agents",
  "eliza-classic": "agents",
  vision: "media",
  rss: "media",
  "gmail-watch": "media",
  prose: "media",
  form: "media",
  cron: "automation",
  scheduling: "automation",
  todo: "automation",
  commands: "automation",
  "s3-storage": "storage",
  "trajectory-logger": "storage",
  experience: "storage",
  minecraft: "gaming",
  roblox: "gaming",
  babylon: "gaming",
  mysticism: "gaming",
  moltbook: "gaming",
};

const SUBGROUP_ORDER: Record<string, number> = {
  "ai-provider": 0,
  connector: 1,
  streaming: 2,
  voice: 3,
  blockchain: 4,
  devtools: 5,
  documents: 6,
  agents: 7,
  media: 8,
  automation: 9,
  storage: 10,
  gaming: 11,
  "feature-other": 12,
};

const DEFAULT_ICONS: Record<string, string> = {
  anthropic: "Brain",
  "google-genai": "Sparkles",
  groq: "Zap",
  "local-ai": "Monitor",
  ollama: "Bot",
  openai: "CircleDashed",
  openrouter: "Shuffle",
  "vercel-ai-gateway": "Triangle",
  xai: "Hash",
  discord: "MessageCircle",
  telegram: "Send",
  slack: "Briefcase",
  twitter: "Twitter",
  whatsapp: "Smartphone",
  signal: "Lock",
  imessage: "MessageSquare",
  bluesky: "Leaf",
  farcaster: "Circle",
  instagram: "Video",
  nostr: "Fingerprint",
  twitch: "Gamepad2",
  matrix: "Link",
  mattermost: "Diamond",
  msteams: "Square",
  "google-chat": "MessagesSquare",
  feishu: "Feather",
  line: "Circle",
  "nextcloud-talk": "Cloud",
  tlon: "Tornado",
  zalo: "Circle",
  zalouser: "Circle",
  wechat: "Phone",
  "edge-tts": "Volume2",
  elevenlabs: "Mic",
  tts: "Volume2",
  "robot-voice": "Mic",
  evm: "Link",
  solana: "CircleDot",
  "auto-trader": "TrendingDown",
  "lp-manager": "Wallet",
  "social-alpha": "Layers",
  polymarket: "Gamepad2",
  x402: "CreditCard",
  trust: "Handshake",
  iq: "Puzzle",
  cli: "Hash",
  code: "Puzzle",
  shell: "Shell",
  github: "Github",
  linear: "Square",
  mcp: "Puzzle",
  browser: "Chrome",
  computeruse: "MousePointer2",
  workflow: "Settings",
  webhooks: "Webhook",
  documents: "BookOpen",
  memory: "Dna",
  "local-embedding": "Binary",
  pdf: "FileText",
  clipboard: "StickyNote",
  rlm: "RefreshCw",
  "agent-orchestrator": "Target",
  "agent-skills": "Wrench",
  "plugin-manager": "Package",
  "copilot-proxy": "Handshake",
  directives: "ClipboardList",
  goals: "Target",
  "eliza-classic": "Bot",
  vision: "Eye",
  rss: "Rss",
  "gmail-watch": "Mail",
  prose: "PenTool",
  form: "ClipboardList",
  cron: "Clock",
  scheduling: "Calendar",
  todo: "ClipboardList",
  commands: "Command",
  "s3-storage": "Server",
  "trajectory-logger": "TrendingDown",
  experience: "Star",
  minecraft: "Pickaxe",
  roblox: "BrickWall",
  babylon: "Gamepad",
  mysticism: "Sparkle",
  moltbook: "ScrollText",
  tee: "LockKeyhole",
  blooio: "Circle",
  acp: "Construction",
  elizacloud: "Cloud",
  twilio: "Phone",
};

// ---------------------------------------------------------------------------
// Per-field heuristics — collapses paramsToSchema's branching into a single
// pure function returning a ConfigField.
// ---------------------------------------------------------------------------

function detectFieldType(
  key: string,
  param: LegacyPluginParameter,
): ConfigField["type"] {
  const k = key.toUpperCase();
  const desc = (param.description ?? "").toLowerCase();

  if (param.sensitive) return "secret";
  if (param.type === "boolean") return "boolean";
  if (param.type === "number") return "number";

  if (
    k.endsWith("_PATH") ||
    k.endsWith("_DIR") ||
    k.endsWith("_DIRECTORY") ||
    k.endsWith("_FOLDER") ||
    k.endsWith("_FILE")
  ) {
    return "file-path";
  }

  if (k.includes("URL") || k.includes("ENDPOINT")) return "url";

  if (
    k.includes("PORT") ||
    k.includes("TIMEOUT") ||
    k.includes("INTERVAL") ||
    k.includes("_MS") ||
    k.includes("COUNT") ||
    k.includes("LIMIT") ||
    k.startsWith("MAX_") ||
    k.includes("RETRY") ||
    k.includes("RETRIES") ||
    k.includes("_RATE") ||
    k.includes("DELAY") ||
    k.includes("THRESHOLD") ||
    k.includes("_SIZE") ||
    k.includes("TEMPERATURE") ||
    k.includes("_DEPTH") ||
    k.includes("_PERCENT") ||
    k.includes("_RATIO")
  ) {
    return "number";
  }

  if (
    k.includes("SHOULD_") ||
    k.endsWith("_ENABLED") ||
    k.endsWith("_DISABLED") ||
    k.startsWith("USE_") ||
    k.startsWith("ALLOW_") ||
    k.startsWith("IS_") ||
    k.startsWith("ENABLE_") ||
    k.startsWith("DISABLE_") ||
    k.startsWith("FORCE_")
  ) {
    return "boolean";
  }

  if (
    desc.includes("json-encoded") ||
    desc.includes("json array") ||
    desc.includes("serialized") ||
    desc.includes("json format")
  ) {
    return "json";
  }

  if (
    k.includes("INSTRUCTIONS") ||
    k.includes("_GREETING") ||
    k.endsWith("_PROMPT") ||
    k.endsWith("_TEMPLATE") ||
    k.includes("SYSTEM_MESSAGE") ||
    (param.description && param.description.length > 200)
  ) {
    return "textarea";
  }

  return "string";
}

function isAdvanced(key: string, param: LegacyPluginParameter): boolean {
  const k = key.toUpperCase();
  const d = (param.description ?? "").toLowerCase();
  return (
    k.includes("EXPERIMENTAL") ||
    k.includes("DEBUG") ||
    k.includes("VERBOSE") ||
    k.includes("TELEMETRY") ||
    d.includes("experimental") ||
    d.includes("advanced") ||
    d.includes("debug")
  );
}

function autoLabel(key: string): string {
  return key
    .replace(/^[A-Z]+_/, "")
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function convertField(key: string, param: LegacyPluginParameter): ConfigField {
  const type = detectFieldType(key, param);
  const k = key.toUpperCase();

  const field: ConfigField = {
    type,
    required: param.required ?? false,
    sensitive: param.sensitive ?? false,
    label: autoLabel(key),
    advanced: isAdvanced(key, param),
  };

  if (param.description) field.help = param.description;
  if (param.default !== undefined && param.default !== null) {
    field.default =
      typeof param.default === "boolean" ||
      typeof param.default === "number" ||
      typeof param.default === "string"
        ? param.default
        : String(param.default);
  }

  if (type === "number") {
    if (k.includes("PORT")) {
      field.min = 1;
      field.max = 65535;
    } else if (
      k.includes("TIMEOUT") ||
      k.includes("INTERVAL") ||
      k.includes("_MS")
    ) {
      field.min = 0;
      field.unit = "ms";
    } else if (
      k.includes("COUNT") ||
      k.includes("LIMIT") ||
      k.startsWith("MAX_")
    ) {
      field.min = 0;
    } else if (k.includes("RETRY") || k.includes("RETRIES")) {
      field.min = 0;
      field.max = 100;
    }
  }

  if (k.includes("MODEL") && type === "string") {
    if (k.includes("EMBEDDING")) {
      field.placeholder = "e.g., text-embedding-3-small";
    } else if (k.includes("TTS")) {
      field.placeholder = "e.g., tts-1, eleven_multilingual_v2";
    } else if (k.includes("STT")) {
      field.placeholder = "e.g., whisper-1";
    } else {
      field.placeholder = "e.g., gpt-4o, claude-sonnet-4-20250514";
    }
  }

  return field;
}

// ---------------------------------------------------------------------------
// Kind / subtype mapping.
// ---------------------------------------------------------------------------

function categorize(p: LegacyPlugin): {
  kind: RegistryEntry["kind"];
  subtype: string;
  group: string;
  groupOrder: number;
  visible: boolean;
} {
  if (p.category === "app") {
    return {
      kind: "app",
      subtype: "tool",
      group: "Apps",
      groupOrder: 0,
      visible: true,
    };
  }

  if (p.category === "connector") {
    return {
      kind: "connector",
      subtype: "messaging",
      group: "connector",
      groupOrder: SUBGROUP_ORDER.connector,
      visible: VISIBLE_CONNECTOR_IDS.has(p.id),
    };
  }

  if (p.category === "streaming") {
    return {
      kind: "connector",
      subtype: "streaming",
      group: "streaming",
      groupOrder: SUBGROUP_ORDER.streaming,
      visible: true,
    };
  }

  if (p.category === "ai-provider") {
    return {
      kind: "plugin",
      subtype: "ai-provider",
      group: "ai-provider",
      groupOrder: SUBGROUP_ORDER["ai-provider"],
      visible: true,
    };
  }

  if (p.category === "database") {
    return {
      kind: "plugin",
      subtype: "database",
      group: "feature-other",
      groupOrder: SUBGROUP_ORDER["feature-other"],
      visible: false,
    };
  }

  const featureSubgroup = FEATURE_SUBGROUP[p.id] ?? "feature-other";
  return {
    kind: "plugin",
    subtype: (featureSubgroup === "feature-other"
      ? "other"
      : featureSubgroup) as never,
    group: featureSubgroup,
    groupOrder: SUBGROUP_ORDER[featureSubgroup] ?? 12,
    visible: true,
  };
}

function determineActions(
  kind: RegistryEntry["kind"],
): RegistryEntry["render"]["actions"] {
  if (kind === "app") return ["launch", "configure", "uninstall"];
  if (kind === "connector") return ["enable", "configure", "setup-guide"];
  return ["enable", "configure"];
}

// ---------------------------------------------------------------------------
// Build a single RegistryEntry from a legacy plugin.
// ---------------------------------------------------------------------------

function convert(p: LegacyPlugin): RegistryEntry {
  const cat = categorize(p);
  const config: Record<string, ConfigField> = {};
  for (const [key, param] of Object.entries(p.pluginParameters ?? {})) {
    config[key] = convertField(key, param);
  }

  const base = {
    id: p.id,
    name: p.name,
    description: p.description,
    npmName: p.npmName,
    version: p.version,
    source: "bundled" as const,
    tags: p.tags ?? [],
    config,
    render: {
      visible: cat.visible,
      pinTo: [],
      style:
        cat.kind === "connector" ? ("setup-panel" as const) : ("card" as const),
      icon: p.icon ?? DEFAULT_ICONS[p.id],
      group: cat.group,
      groupOrder: cat.groupOrder,
      actions: determineActions(cat.kind),
    },
    resources: {
      homepage: p.homepage,
      repository: p.repository,
      setupGuideUrl: p.setupGuideUrl,
    },
    dependsOn: [],
  };

  if (cat.kind === "app") {
    return {
      ...base,
      kind: "app",
      subtype: "tool",
      launch: {
        type: "server-launch",
        capabilities: [],
      },
    };
  }

  if (cat.kind === "connector") {
    return {
      ...base,
      kind: "connector",
      subtype: cat.subtype as never,
      auth: {
        kind: "token",
        credentialKeys: p.envKey ? [p.envKey] : [],
      },
    };
  }

  return {
    ...base,
    kind: "plugin",
    subtype: cat.subtype as never,
  };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

function main(): void {
  const repoRoot = process.cwd();
  const sourcePath = join(repoRoot, "plugins.json");
  const outRoot = join(
    repoRoot,
    "eliza/packages/app-core/src/registry/entries",
  );

  const raw = JSON.parse(readFileSync(sourcePath, "utf-8")) as LegacyIndex;

  const stats = { app: 0, plugin: 0, connector: 0, hidden: 0, errors: 0 };

  for (const legacy of raw.plugins) {
    const candidate = convert(legacy);
    const parsed = registryEntrySchema.safeParse(candidate);
    if (!parsed.success) {
      stats.errors += 1;
      console.error(`✗ ${legacy.id}:`, parsed.error.issues[0]);
      continue;
    }
    const entry = parsed.data;
    const outDir = join(outRoot, `${entry.kind}s`);
    mkdirSync(outDir, { recursive: true });
    const outFile = join(outDir, `${entry.id}.json`);
    writeFileSync(outFile, `${JSON.stringify(entry, null, 2)}\n`);
    stats[entry.kind] += 1;
    if (!entry.render.visible) stats.hidden += 1;
  }

  const total = stats.app + stats.plugin + stats.connector;
  console.log(`Generated ${total} entries:`);
  console.log(`  apps:       ${stats.app}`);
  console.log(`  plugins:    ${stats.plugin}`);
  console.log(`  connectors: ${stats.connector}`);
  console.log(`  hidden:     ${stats.hidden}`);
  if (stats.errors > 0) {
    console.error(`\n${stats.errors} entries failed validation.`);
    process.exit(1);
  }
}

main();
