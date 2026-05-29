import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

type JsonPrimitive = string | number | boolean | null;
type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];
type JsonObject = { readonly [key: string]: JsonValue };

type Category =
  | "core-runtime"
  | "desktop-shell"
  | "production-ui"
  | "app-plugin"
  | "connector-plugin"
  | "model-plugin"
  | "voice-plugin"
  | "native-semantic-plugin"
  | "desktop-capability"
  | "data-memory-plugin"
  | "dev-tooling"
  | "provider-plugin"
  | "obsolete-or-duplicate"
  | "unknown";

type KeepAs =
  | "core"
  | "plugin"
  | "app-plugin"
  | "connector"
  | "remote"
  | "dynamic-view-template"
  | "trace-source"
  | "voice-pipeline-participant"
  | "model-pipeline-participant"
  | "delete-candidate"
  | "needs-review";

type RelatedRemote =
  | "eliza.runtime"
  | "eliza.fs"
  | "eliza.pty"
  | "eliza.git"
  | "eliza.local-model";

type RelatedLayer =
  | "dynamic-views"
  | "trace"
  | "voice"
  | "local-inference"
  | "production-app"
  | "electrobun-shell"
  | "agent-runtime";

type RecommendedNextAction =
  | "leave-alone"
  | "add-trace-hooks"
  | "add-dynamic-view-manifest"
  | "route-through-runtime-broker"
  | "connect-to-voice-pipeline"
  | "connect-to-local-model"
  | "dedupe-with-existing-plugin"
  | "deprecate"
  | "delete-after-confirmation"
  | "needs-owner-decision";

type Risk = "low" | "medium" | "high";

type ConvergenceAuditEntry = {
  id: string;
  path: string;
  category: Category;
  currentPurpose: string;
  keepAs: KeepAs;
  shouldBecomeRemote: boolean;
  shouldRegisterDynamicViews: boolean;
  shouldEmitTraceEvents: boolean;
  shouldUseRuntimeBroker: boolean;
  shouldStayOutOfElectrobun: boolean;
  relatedRemotes?: RelatedRemote[];
  relatedLayers?: RelatedLayer[];
  recommendedNextAction: RecommendedNextAction;
  risk: Risk;
  ownerDecisionNeeded?: boolean;
  notes: string;
};

type DeletionCandidate = {
  path: string;
  reason: string;
  confidence: "low" | "medium" | "high";
  safeToDeleteNow: boolean;
  requiresOwnerDecision: boolean;
  validationNeeded: string[];
};

type PackageJson = {
  name?: string;
  description?: string;
};

type AuditDocument = {
  generatedAt: string;
  branch: string;
  aheadBehind: string;
  dirtyStatus: string[];
  entries: ConvergenceAuditEntry[];
  deletionCandidates: DeletionCandidate[];
  summaries: {
    byCategory: Record<Category, number>;
    byRecommendedNextAction: Record<RecommendedNextAction, number>;
    hardNoMigration: string[];
    currentRemotes: string[];
    futureRemoteCandidates: string[];
    traceFirstCandidates: string[];
    dynamicViewCandidates: string[];
    voiceLocalModelCandidates: string[];
    runtimeBrokerCandidates: string[];
    ownerDecisionItems: string[];
  };
};

const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const ELECTROBUN_ROOT = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(ELECTROBUN_ROOT, "../../../..");
const DOCS_DIR = path.join(ELECTROBUN_ROOT, "docs");

const CATEGORY_ORDER: readonly Category[] = [
  "core-runtime",
  "desktop-shell",
  "production-ui",
  "app-plugin",
  "connector-plugin",
  "model-plugin",
  "voice-plugin",
  "native-semantic-plugin",
  "desktop-capability",
  "data-memory-plugin",
  "dev-tooling",
  "provider-plugin",
  "obsolete-or-duplicate",
  "unknown",
];

const ACTION_ORDER: readonly RecommendedNextAction[] = [
  "leave-alone",
  "add-trace-hooks",
  "add-dynamic-view-manifest",
  "route-through-runtime-broker",
  "connect-to-voice-pipeline",
  "connect-to-local-model",
  "dedupe-with-existing-plugin",
  "deprecate",
  "delete-after-confirmation",
  "needs-owner-decision",
];

const CONNECTOR_NAMES = new Set([
  "plugin-bluebubbles",
  "plugin-bluesky",
  "plugin-calendly",
  "plugin-discord",
  "plugin-discord-local",
  "plugin-farcaster",
  "plugin-feishu",
  "plugin-github",
  "plugin-google",
  "plugin-google-chat",
  "plugin-google-meet-cute",
  "plugin-imessage",
  "plugin-instagram",
  "plugin-line",
  "plugin-linear",
  "plugin-matrix",
  "plugin-mcp",
  "plugin-messages",
  "plugin-ngrok",
  "plugin-nostr",
  "plugin-shopify",
  "plugin-signal",
  "plugin-slack",
  "plugin-social-alpha",
  "plugin-tailscale",
  "plugin-telegram",
  "plugin-tunnel",
  "plugin-twitch",
  "plugin-vincent",
  "plugin-web-search",
  "plugin-wechat",
  "plugin-whatsapp",
  "plugin-x",
  "plugin-x402",
  "plugin-xmtp",
]);

const PROVIDER_NAMES = new Set([
  "plugin-anthropic",
  "plugin-anthropic-proxy",
  "plugin-google-genai",
  "plugin-groq",
  "plugin-openai",
  "plugin-openrouter",
  "plugin-xai",
  "plugin-zai",
]);

const MODEL_NAMES = new Set([
  "plugin-aosp-local-inference",
  "plugin-local-inference",
  "plugin-lmstudio",
  "plugin-native-llama",
  "plugin-ollama",
  "plugin-omnivoice",
  "plugin-rlm",
]);

const VOICE_NAMES = new Set([
  "plugin-edge-tts",
  "plugin-elevenlabs",
  "plugin-native-talkmode",
  "plugin-omnivoice",
]);

const DATA_NAMES = new Set([
  "plugin-inmemorydb",
  "plugin-local-storage",
  "plugin-localdb",
  "plugin-sql",
]);

const APP_PLUGIN_NAMES = new Set([
  "app-model-tester",
  "plugin-app-control",
  "plugin-app-manager",
  "plugin-browser",
  "plugin-2004scape",
  "plugin-feed",
  "plugin-clawville",
  "plugin-companion",
  "plugin-defense-of-the-agents",
  "plugin-documents",
  "plugin-eliza-classic",
  "plugin-elizacloud",
  "plugin-elizamaker",
  "plugin-form",
  "plugin-health",
  "plugin-hyperliquid-app",
  "plugin-hyperscape",
  "plugin-lifeops",
  "plugin-minecraft",
  "plugin-music",
  "plugin-mysticism",
  "plugin-pdf",
  "plugin-phone",
  "plugin-polymarket-app",
  "plugin-roblox",
  "plugin-scape",
  "plugin-shopify-ui",
  "plugin-steward-app",
  "plugin-suno",
  "plugin-task-coordinator",
  "plugin-todos",
  "plugin-training",
  "plugin-video",
  "plugin-vision",
  "plugin-wallet",
  "plugin-wallet-ui",
  "plugin-workflow",
]);

const DEV_TOOL_NAMES = new Set([
  "plugin-action-bench",
  "plugin-agent-orchestrator",
  "plugin-agent-skills",
  "plugin-background-runner",
  "plugin-benchmarks",
  "plugin-cli",
  "plugin-codex-cli",
  "plugin-coding-tools",
  "plugin-commands",
  "plugin-registry",
  "plugin-streaming",
  "plugin-tee",
  "plugin-trajectory-logger",
]);

const DYNAMIC_VIEW_NAMES = new Set([
  "app-model-tester",
  "plugin-agent-orchestrator",
  "plugin-agent-skills",
  "plugin-browser",
  "plugin-coding-tools",
  "plugin-computeruse",
  "plugin-documents",
  "plugin-github",
  "plugin-native-canvas",
  "plugin-native-screencapture",
  "plugin-task-coordinator",
  "plugin-training",
  "plugin-workflow",
]);

const RUNTIME_BROKER_NAMES = new Set([
  "plugin-browser",
  "plugin-codex-cli",
  "plugin-coding-tools",
  "plugin-computeruse",
  "plugin-device-filesystem",
  "plugin-device-settings",
  "plugin-native-activity-tracker",
  "plugin-native-appblocker",
  "plugin-native-bun-runtime",
  "plugin-native-calendar",
  "plugin-native-camera",
  "plugin-native-canvas",
  "plugin-native-contacts",
  "plugin-native-desktop",
  "plugin-native-location",
  "plugin-native-macosalarm",
  "plugin-native-messages",
  "plugin-native-phone",
  "plugin-native-screencapture",
  "plugin-native-system",
  "plugin-native-wifi",
  "plugin-screenshare",
  "plugin-shell",
  "plugin-contacts",
  "plugin-capacitor-bridge",
  "plugin-wifi",
]);

const TRACE_FIRST_NAMES = new Set([
  "plugin-agent-orchestrator",
  "plugin-agent-skills",
  "plugin-browser",
  "plugin-coding-tools",
  "plugin-computeruse",
  "plugin-discord",
  "plugin-documents",
  "plugin-github",
  "plugin-local-inference",
  "plugin-native-screencapture",
  "plugin-native-talkmode",
  "plugin-task-coordinator",
  "plugin-training",
  "plugin-workflow",
]);

const REMOTE_IDS = new Map([
  ["runtime", "eliza.runtime"],
  ["fs", "eliza.fs"],
  ["pty", "eliza.pty"],
  ["git", "eliza.git"],
  ["local-model", "eliza.local-model"],
  ["surface", "eliza.surface"],
]);

const REMOTE_RELATED = new Map<string, RelatedRemote[]>([
  ["runtime", ["eliza.runtime"]],
  ["fs", ["eliza.fs"]],
  ["pty", ["eliza.pty"]],
  ["git", ["eliza.git"]],
  ["local-model", ["eliza.local-model"]],
  ["surface", ["eliza.runtime"]],
]);

const AUDIT_OUTPUT_PATHS = new Set([
  "packages/app-core/platforms/electrobun/docs/convergence-audit.json",
  "packages/app-core/platforms/electrobun/docs/convergence-audit.md",
  "packages/app-core/platforms/electrobun/scripts/generate-convergence-audit.ts",
]);

const AUDIT_OUTPUT_PREFIXES = ["packages/app-core/platforms/electrobun/docs/"];

function relativePath(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath);
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(path.join(REPO_ROOT, targetPath));
    return true;
  } catch {
    return false;
  }
}

async function readPackageJson(directory: string): Promise<PackageJson | null> {
  const filePath = path.join(REPO_ROOT, directory, "package.json");
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as JsonValue;
    if (!isJsonObject(parsed)) return null;
    const name = parsed.name;
    const description = parsed.description;
    return {
      name: typeof name === "string" ? name : undefined,
      description: typeof description === "string" ? description : undefined,
    };
  } catch {
    return null;
  }
}

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}

function countBy<T extends string>(
  values: readonly T[],
  items: readonly T[],
): Record<T, number> {
  const result = Object.fromEntries(
    values.map((value) => [value, 0]),
  ) as Record<T, number>;
  for (const item of items) result[item] += 1;
  return result;
}

function packagePurpose(
  packageJson: PackageJson | null,
  fallback: string,
): string {
  return packageJson?.description?.trim() || fallback;
}

function nativeRelatedRemote(id: string): RelatedRemote[] | undefined {
  if (id.includes("filesystem")) return ["eliza.fs"];
  if (id.includes("shell") || id.includes("terminal")) return ["eliza.pty"];
  if (id.includes("coding-tools") || id.includes("codex")) {
    return ["eliza.runtime", "eliza.fs", "eliza.pty", "eliza.git"];
  }
  if (id.includes("local-inference") || id.includes("llama")) {
    return ["eliza.local-model"];
  }
  if (id.includes("computeruse") || id.includes("browser")) {
    return ["eliza.runtime"];
  }
  if (id.includes("screen") || id.includes("camera")) {
    return ["eliza.runtime"];
  }
  return undefined;
}

function classifyPlugin(id: string): {
  category: Category;
  keepAs: KeepAs;
  action: RecommendedNextAction;
  risk: Risk;
} {
  if (VOICE_NAMES.has(id)) {
    return {
      category: "voice-plugin",
      keepAs: "voice-pipeline-participant",
      action: "connect-to-voice-pipeline",
      risk: "medium",
    };
  }
  if (MODEL_NAMES.has(id)) {
    return {
      category: "model-plugin",
      keepAs: "model-pipeline-participant",
      action: "connect-to-local-model",
      risk: "medium",
    };
  }
  if (CONNECTOR_NAMES.has(id)) {
    return {
      category: "connector-plugin",
      keepAs: "connector",
      action: "add-trace-hooks",
      risk: "medium",
    };
  }
  if (PROVIDER_NAMES.has(id)) {
    return {
      category: "provider-plugin",
      keepAs: "plugin",
      action: "leave-alone",
      risk: "low",
    };
  }
  if (
    id.startsWith("plugin-native-") ||
    id.startsWith("plugin-device-") ||
    RUNTIME_BROKER_NAMES.has(id)
  ) {
    return {
      category: "native-semantic-plugin",
      keepAs: "plugin",
      action: RUNTIME_BROKER_NAMES.has(id)
        ? "route-through-runtime-broker"
        : "add-trace-hooks",
      risk: "medium",
    };
  }
  if (DATA_NAMES.has(id)) {
    return {
      category: "data-memory-plugin",
      keepAs: "plugin",
      action: "leave-alone",
      risk: "low",
    };
  }
  if (APP_PLUGIN_NAMES.has(id) || id.endsWith("-app")) {
    return {
      category: "app-plugin",
      keepAs: "app-plugin",
      action: DYNAMIC_VIEW_NAMES.has(id)
        ? "add-dynamic-view-manifest"
        : "add-trace-hooks",
      risk: "medium",
    };
  }
  if (DEV_TOOL_NAMES.has(id)) {
    return {
      category: "dev-tooling",
      keepAs: "plugin",
      action: TRACE_FIRST_NAMES.has(id) ? "add-trace-hooks" : "leave-alone",
      risk: "medium",
    };
  }
  if (id === "plugin-computeruse" || id === "plugin-screenshare") {
    return {
      category: "native-semantic-plugin",
      keepAs: "plugin",
      action: "route-through-runtime-broker",
      risk: "medium",
    };
  }
  return {
    category: "unknown",
    keepAs: "needs-review",
    action: "needs-owner-decision",
    risk: "medium",
  };
}

function pluginNotes(id: string, category: Category): string {
  if (CONNECTOR_NAMES.has(id)) {
    return "Keep as a connector plugin. Add trace hooks for ingress, action execution, reply, rate limit, and failure events where useful.";
  }
  if (DYNAMIC_VIEW_NAMES.has(id)) {
    return "Keep existing plugin boundary. Add contextual dynamic views only for task-specific inspection, not a fixed dashboard.";
  }
  if (VOICE_NAMES.has(id)) {
    return "Keep as a runtime voice participant. Wire availability, ASR/TTS/turn events, and latency into eliza.voice and trace.";
  }
  if (MODEL_NAMES.has(id)) {
    return "Keep as model/local-inference integration. Use eliza.local-model and voice validation as control and observability wrappers.";
  }
  if (category === "native-semantic-plugin") {
    return "Keep as the agent-facing semantic plugin. Route host/system execution through Electrobun or an existing Remote when needed.";
  }
  if (category === "provider-plugin") {
    return "Keep as a provider plugin. Do not move provider routing into Electrobun or a Remote.";
  }
  if (category === "data-memory-plugin") {
    return "Keep as a data or memory plugin. Do not duplicate storage semantics in Electrobun.";
  }
  return "Needs owner review before any migration, deletion, or dynamic-view work.";
}

async function pluginEntry(directory: string): Promise<ConvergenceAuditEntry> {
  const id = path.basename(directory);
  const packageJson = await readPackageJson(directory);
  const classification = classifyPlugin(id);
  const shouldRegisterDynamicViews = DYNAMIC_VIEW_NAMES.has(id);
  const shouldEmitTraceEvents =
    TRACE_FIRST_NAMES.has(id) ||
    CONNECTOR_NAMES.has(id) ||
    classification.category === "native-semantic-plugin";
  const shouldUseRuntimeBroker = RUNTIME_BROKER_NAMES.has(id);
  const relatedRemotes = nativeRelatedRemote(id);
  const relatedLayers: RelatedLayer[] = [];
  if (shouldRegisterDynamicViews) relatedLayers.push("dynamic-views");
  if (shouldEmitTraceEvents) relatedLayers.push("trace");
  if (VOICE_NAMES.has(id)) relatedLayers.push("voice");
  if (MODEL_NAMES.has(id)) relatedLayers.push("local-inference");
  return {
    id,
    path: directory,
    category: classification.category,
    currentPurpose: packagePurpose(packageJson, `Plugin package ${id}.`),
    keepAs: classification.keepAs,
    shouldBecomeRemote: false,
    shouldRegisterDynamicViews,
    shouldEmitTraceEvents,
    shouldUseRuntimeBroker,
    shouldStayOutOfElectrobun:
      classification.category === "connector-plugin" ||
      classification.category === "provider-plugin" ||
      classification.category === "app-plugin",
    relatedRemotes,
    relatedLayers: relatedLayers.length > 0 ? relatedLayers : undefined,
    recommendedNextAction: shouldRegisterDynamicViews
      ? "add-dynamic-view-manifest"
      : classification.action,
    risk: classification.risk,
    ownerDecisionNeeded: classification.category === "unknown" || undefined,
    notes: pluginNotes(id, classification.category),
  };
}

async function directDirectories(parent: string): Promise<string[]> {
  const absoluteParent = path.join(REPO_ROOT, parent);
  const entries = await readdir(absoluteParent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .sort();
}

async function packageEntry(params: {
  id: string;
  path: string;
  category: Category;
  keepAs: KeepAs;
  action: RecommendedNextAction;
  notes: string;
  currentPurpose: string;
  risk?: Risk;
  shouldRegisterDynamicViews?: boolean;
  shouldEmitTraceEvents?: boolean;
  shouldUseRuntimeBroker?: boolean;
  shouldStayOutOfElectrobun?: boolean;
  relatedRemotes?: RelatedRemote[];
  relatedLayers?: RelatedLayer[];
  shouldBecomeRemote?: boolean;
  ownerDecisionNeeded?: boolean;
}): Promise<ConvergenceAuditEntry> {
  const packageJson = await readPackageJson(params.path);
  return {
    id: params.id,
    path: params.path,
    category: params.category,
    currentPurpose: packagePurpose(packageJson, params.currentPurpose),
    keepAs: params.keepAs,
    shouldBecomeRemote: params.shouldBecomeRemote ?? false,
    shouldRegisterDynamicViews: params.shouldRegisterDynamicViews ?? false,
    shouldEmitTraceEvents: params.shouldEmitTraceEvents ?? false,
    shouldUseRuntimeBroker: params.shouldUseRuntimeBroker ?? false,
    shouldStayOutOfElectrobun: params.shouldStayOutOfElectrobun ?? false,
    relatedRemotes: params.relatedRemotes,
    relatedLayers: params.relatedLayers,
    recommendedNextAction: params.action,
    risk: params.risk ?? "low",
    ownerDecisionNeeded: params.ownerDecisionNeeded,
    notes: params.notes,
  };
}

async function remoteEntries(): Promise<ConvergenceAuditEntry[]> {
  const directories = await directDirectories(
    "packages/app-core/platforms/electrobun/remotes",
  );
  return Promise.all(
    directories.map(async (directory) => {
      const basename = path.basename(directory);
      const id = REMOTE_IDS.get(basename) ?? `eliza.${basename}`;
      const packageJson = await readPackageJson(directory);
      return {
        id,
        path: directory,
        category: basename === "surface" ? "dev-tooling" : "desktop-capability",
        currentPurpose: packagePurpose(
          packageJson,
          `${id} first-party Electrobun Remote.`,
        ),
        keepAs: "remote",
        shouldBecomeRemote: false,
        shouldRegisterDynamicViews: basename === "surface",
        shouldEmitTraceEvents: basename !== "surface",
        shouldUseRuntimeBroker: basename !== "surface",
        shouldStayOutOfElectrobun: false,
        relatedRemotes: REMOTE_RELATED.get(basename),
        relatedLayers:
          basename === "surface"
            ? ["dynamic-views", "trace"]
            : ["electrobun-shell", "agent-runtime"],
        recommendedNextAction: "leave-alone",
        risk: basename === "surface" ? "medium" : "low",
        notes:
          basename === "surface"
            ? "Dev/admin only. Do not turn into production UI."
            : "Already a desktop/system capability provider. Keep scoped and brokered through host APIs.",
      };
    }),
  );
}

async function deletionCandidates(): Promise<DeletionCandidate[]> {
  const candidates: DeletionCandidate[] = [];
  const generatedPaths = [
    "packages/app-core/platforms/electrobun/build",
    "packages/app-core/platforms/electrobun/native/.build",
    "dist",
  ];
  for (const candidatePath of generatedPaths) {
    if (await pathExists(candidatePath)) {
      candidates.push({
        path: candidatePath,
        reason:
          "Generated local build output. It should not be part of architecture or PR review scope.",
        confidence: "medium",
        safeToDeleteNow: false,
        requiresOwnerDecision: false,
        validationNeeded: [
          "confirm ignored/untracked status",
          "rerun build if removed",
        ],
      });
    }
  }
  const pluginDirectories = await directDirectories("plugins");
  for (const directory of pluginDirectories) {
    if (
      (path.basename(directory).startsWith("plugin-") ||
        path.basename(directory).startsWith("app-")) &&
      !(await pathExists(path.join(directory, "package.json")))
    ) {
      candidates.push({
        path: directory,
        reason:
          "Plugin-shaped directory without package.json. Needs owner review before deletion or restoration.",
        confidence: "low",
        safeToDeleteNow: false,
        requiresOwnerDecision: true,
        validationNeeded: [
          "search imports",
          "check package registry references",
        ],
      });
    }
  }
  return candidates;
}

async function buildEntries(): Promise<ConvergenceAuditEntry[]> {
  const manualEntries = await Promise.all([
    packageEntry({
      id: "repo-root",
      path: ".",
      category: "core-runtime",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Workspace root and monorepo coordination.",
      notes:
        "Keep as workspace root. Do not use Electrobun convergence to change global repo ownership.",
      relatedLayers: ["agent-runtime"],
    }),
    packageEntry({
      id: "packages/core",
      path: "packages/core",
      category: "core-runtime",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Core Eliza agent runtime package.",
      notes: "Hard no-migration item. Runtime semantics stay here.",
      shouldStayOutOfElectrobun: true,
      relatedLayers: ["agent-runtime"],
    }),
    packageEntry({
      id: "packages/agent",
      path: "packages/agent",
      category: "core-runtime",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Agent runtime/server package.",
      notes:
        "AgentManager/Electrobun may own lifecycle, but agent runtime code stays in runtime packages.",
      shouldStayOutOfElectrobun: true,
      relatedLayers: ["agent-runtime"],
    }),
    packageEntry({
      id: "packages/app",
      path: "packages/app",
      category: "production-ui",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Cross-platform production app UI.",
      notes:
        "Hard no-migration item. Do not replace with eliza.surface or fixed dynamic-view panels.",
      shouldStayOutOfElectrobun: true,
      relatedLayers: ["production-app"],
    }),
    packageEntry({
      id: "packages/app-core",
      path: "packages/app-core",
      category: "core-runtime",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Shared app shell/core package.",
      notes:
        "Hard no-migration item. Electrobun platform code can add host docs, not absorb app-core ownership.",
      relatedLayers: ["production-app", "electrobun-shell"],
    }),
    packageEntry({
      id: "packages/app-core/platforms/electrobun",
      path: "packages/app-core/platforms/electrobun",
      category: "desktop-shell",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Electrobun native desktop shell.",
      notes:
        "Electrobun is the shell, not the agent runtime. Keep AgentManager as runtime lifecycle owner.",
      relatedLayers: ["electrobun-shell", "dynamic-views", "trace"],
    }),
    packageEntry({
      id: "packages/electrobun-remote-plugins",
      path: "packages/electrobun-remote-plugins",
      category: "desktop-shell",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Electrobun module/Remote package substrate.",
      notes:
        "Keep as module runtime substrate. Do not turn into a second plugin system.",
      relatedLayers: ["electrobun-shell"],
    }),
    packageEntry({
      id: "packages/shared/src/local-inference",
      path: "packages/shared/src/local-inference",
      category: "model-plugin",
      keepAs: "model-pipeline-participant",
      action: "connect-to-local-model",
      currentPurpose:
        "Shared local-inference model catalog, routing, paths, and voice metadata.",
      notes:
        "Source of truth for Eliza-1 and voice metadata. Do not duplicate in Electrobun.",
      shouldEmitTraceEvents: true,
      shouldStayOutOfElectrobun: true,
      relatedRemotes: ["eliza.local-model"],
      relatedLayers: ["local-inference", "voice"],
      risk: "medium",
    }),
    packageEntry({
      id: "packages/app-core/platforms/electrobun/src/dynamic-views",
      path: "packages/app-core/platforms/electrobun/src/dynamic-views",
      category: "desktop-shell",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Dynamic view registry/session infrastructure.",
      notes:
        "Contextual view substrate only. Do not convert into dashboard navigation.",
      shouldRegisterDynamicViews: true,
      relatedLayers: ["dynamic-views", "electrobun-shell"],
    }),
    packageEntry({
      id: "packages/app-core/platforms/electrobun/src/trace",
      path: "packages/app-core/platforms/electrobun/src/trace",
      category: "desktop-shell",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose: "Trace service and dynamic trace view infrastructure.",
      notes:
        "Observability spine. Plugins should emit trace events; trace should not become a static dashboard.",
      shouldRegisterDynamicViews: true,
      shouldEmitTraceEvents: true,
      relatedLayers: ["trace", "dynamic-views"],
    }),
    packageEntry({
      id: "packages/app-core/platforms/electrobun/src/voice",
      path: "packages/app-core/platforms/electrobun/src/voice",
      category: "desktop-shell",
      keepAs: "core",
      action: "leave-alone",
      currentPurpose:
        "Voice pipeline instrumentation, adapter, and validation layer.",
      notes:
        "Voice is a pipeline. Keep live behavior gated and report through trace.",
      shouldRegisterDynamicViews: true,
      shouldEmitTraceEvents: true,
      relatedLayers: ["voice", "trace", "dynamic-views", "local-inference"],
    }),
    packageEntry({
      id: "future.eliza.computer",
      path: "packages/app-core/platforms/electrobun/remotes/computer",
      category: "desktop-capability",
      keepAs: "needs-review",
      action: "needs-owner-decision",
      currentPurpose:
        "Potential future broker for screen/browser/camera/computer context if existing host APIs need a Remote boundary.",
      notes:
        "Only future Remote candidate. Do not create until a concrete host capability boundary is required.",
      shouldBecomeRemote: true,
      shouldEmitTraceEvents: true,
      shouldUseRuntimeBroker: true,
      relatedLayers: ["electrobun-shell", "trace", "dynamic-views"],
      risk: "medium",
      ownerDecisionNeeded: true,
    }),
  ]);

  const pluginDirectories = (await directDirectories("plugins")).filter(
    (directory) =>
      path.basename(directory).startsWith("plugin-") ||
      path.basename(directory).startsWith("app-"),
  );
  const pluginEntries = await Promise.all(pluginDirectories.map(pluginEntry));
  return [...manualEntries, ...(await remoteEntries()), ...pluginEntries].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

function list(
  entries: readonly ConvergenceAuditEntry[],
  predicate: (entry: ConvergenceAuditEntry) => boolean,
): string[] {
  return entries
    .filter(predicate)
    .map((entry) => entry.id)
    .sort();
}

function buildSummaries(
  entries: ConvergenceAuditEntry[],
): AuditDocument["summaries"] {
  return {
    byCategory: countBy(
      CATEGORY_ORDER,
      entries.map((entry) => entry.category),
    ),
    byRecommendedNextAction: countBy(
      ACTION_ORDER,
      entries.map((entry) => entry.recommendedNextAction),
    ),
    hardNoMigration: [
      "packages/app",
      "packages/core",
      "packages/agent",
      "packages/app-core",
      "packages/app-core/platforms/electrobun core shell",
      "packages/electrobun-remote-plugins",
      "connector plugins",
      "provider plugins",
      "app plugins",
      "core runtime plugins",
    ],
    currentRemotes: list(entries, (entry) => entry.keepAs === "remote"),
    futureRemoteCandidates: list(entries, (entry) => entry.shouldBecomeRemote),
    traceFirstCandidates: list(
      entries,
      (entry) => entry.shouldEmitTraceEvents && entry.keepAs !== "remote",
    ),
    dynamicViewCandidates: list(
      entries,
      (entry) => entry.shouldRegisterDynamicViews,
    ),
    voiceLocalModelCandidates: list(
      entries,
      (entry) =>
        entry.relatedLayers?.includes("voice") === true ||
        entry.relatedLayers?.includes("local-inference") === true,
    ),
    runtimeBrokerCandidates: list(
      entries,
      (entry) => entry.shouldUseRuntimeBroker,
    ),
    ownerDecisionItems: list(
      entries,
      (entry) =>
        entry.ownerDecisionNeeded === true ||
        entry.recommendedNextAction === "needs-owner-decision",
    ),
  };
}

function markdownList(items: readonly string[]): string {
  if (items.length === 0) return "- None";
  return items.map((item) => `- ${item}`).join("\n");
}

function summaryTable(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `| ${key} | ${count} |`)
    .join("\n");
}

function entriesTable(entries: readonly ConvergenceAuditEntry[]): string {
  const rows = entries.map((entry) =>
    [
      entry.id,
      entry.category,
      entry.keepAs,
      entry.recommendedNextAction,
      entry.shouldRegisterDynamicViews ? "yes" : "no",
      entry.shouldEmitTraceEvents ? "yes" : "no",
      entry.shouldUseRuntimeBroker ? "yes" : "no",
      entry.risk,
      entry.notes.replace(/\|/g, "\\|"),
    ].join(" | "),
  );
  return [
    "| ID | Category | Keep As | Next Action | Dynamic View | Trace | Broker | Risk | Notes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

function deletionTable(candidates: readonly DeletionCandidate[]): string {
  if (candidates.length === 0) return "No deletion candidates were found.";
  return [
    "| Path | Reason | Confidence | Safe Now | Owner Decision | Validation |",
    "| --- | --- | --- | --- | --- | --- |",
    ...candidates.map((candidate) =>
      [
        candidate.path,
        candidate.reason,
        candidate.confidence,
        candidate.safeToDeleteNow ? "yes" : "no",
        candidate.requiresOwnerDecision ? "yes" : "no",
        candidate.validationNeeded.join(", "),
      ].join(" | "),
    ),
  ]
    .map((line) => line.replace(/\| undefined/g, "|"))
    .join("\n");
}

function buildMarkdown(document: AuditDocument): string {
  const s = document.summaries;
  return `# Convergence, Annotation, and Deletion Audit

Generated: ${document.generatedAt}

Branch: ${document.branch}

Ahead/behind origin/develop: ${document.aheadBehind}

Dirty status at generation:

${markdownList(document.dirtyStatus.length > 0 ? document.dirtyStatus : ["clean"])}

## Executive Summary

This audit stops the infrastructure-building spiral. Plugins stay plugins, app plugins stay app/product bundles, connectors stay connector plugins, Electrobun remains the desktop shell, AgentManager remains the runtime owner, and Remotes remain limited to desktop/system capability providers.

The current local branch may still contain multiple phases, but it should not be pushed blindly as a broad mega-PR unless maintainers explicitly want that review shape. The stack recommendation below keeps the work reviewable without changing the architectural boundary decisions.

No Swift host/controller path is part of this architecture. The only retained boundary pattern is typed RPC/local API/SSE between layers.

## Summary Counts

### By Category

| Category | Count |
| --- | --- |
${summaryTable(s.byCategory)}

### By Recommended Next Action

| Action | Count |
| --- | --- |
${summaryTable(s.byRecommendedNextAction)}

## Hard No-Migration List

${markdownList(s.hardNoMigration)}

## Current Remotes

${markdownList(s.currentRemotes)}

eliza.surface remains dev/admin only and is not a production UI replacement.

## Future Remote Candidates

${markdownList(s.futureRemoteCandidates)}

This list is intentionally short. Do not turn connector, provider, or app plugins into Remotes.

## Trace-First Candidates

${markdownList(s.traceFirstCandidates)}

## Dynamic-View Candidates

${markdownList(s.dynamicViewCandidates)}

## Voice/Local-Model Candidates

${markdownList(s.voiceLocalModelCandidates)}

## Runtime-Broker Candidates

${markdownList(s.runtimeBrokerCandidates)}

## Delete/Deprecate Candidates

${deletionTable(document.deletionCandidates)}

## Owner-Decision Items

${markdownList(s.ownerDecisionItems)}

## Proposed Annotation Plan

- Add README-level role annotations to trace-first candidates before wiring behavior.
- Use \`docs/trace-first-annotations.md\` as the first review-boundary map for top trace-first packages.
- Add dynamic-view manifests only for contextual inspection surfaces, not fixed dashboards.
- Keep connector/provider package metadata unchanged unless maintainers already have a metadata convention.
- Keep Remote manifests focused on capability boundaries and trusted/full-permission status.
- Do not add source comments unless a hidden constraint or security boundary would otherwise be unclear.

## PR Stack Recommendation

Do not blindly push every local phase into the platform convergence PR unless maintainers explicitly ask for a mega-PR. Recommended stack:

1. Platform convergence PR
   - first-party Remotes
   - AgentManager-backed eliza.runtime
   - worker invoke/event bridge
   - dynamic view registry/session infrastructure

2. Trace PR
   - TraceStore and TraceService
   - dynamic agent.run.trace view
   - runtime and capability trace hooks

3. Voice instrumentation PR
   - VoiceService
   - mock/text pipeline
   - voice trace integration

4. Live voice adapter PR
   - VoiceRuntimeAdapter
   - live flags
   - ASR/TTS runtime route wiring

5. Voice latency PR
   - latency budgets
   - stream coordinator
   - TTS chunker
   - barge-in semantics

6. Voice validation PR
   - voice:validate scripts
   - structured validation reports

7. Convergence audit PR
   - this matrix and generator
   - no migration or production code changes

## Full Matrix

${entriesTable(document.entries)}
`;
}

async function main(): Promise<void> {
  await mkdir(DOCS_DIR, { recursive: true });
  const entries = await buildEntries();
  const document: AuditDocument = {
    generatedAt: new Date().toISOString(),
    branch: git(["branch", "--show-current"]),
    aheadBehind: git([
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...origin/develop",
    ]),
    dirtyStatus: git(["status", "--short"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => {
        const filePath = line.slice(3);
        return (
          !AUDIT_OUTPUT_PATHS.has(filePath) &&
          !AUDIT_OUTPUT_PREFIXES.some((prefix) => filePath.startsWith(prefix))
        );
      })
      .filter((line) => line.length > 0),
    entries,
    deletionCandidates: await deletionCandidates(),
    summaries: buildSummaries(entries),
  };
  await writeFile(
    path.join(DOCS_DIR, "convergence-audit.json"),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  await writeFile(
    path.join(DOCS_DIR, "convergence-audit.md"),
    buildMarkdown(document),
  );
  process.stdout.write(
    `Wrote ${relativePath(path.join(DOCS_DIR, "convergence-audit.json"))}\n`,
  );
  process.stdout.write(
    `Wrote ${relativePath(path.join(DOCS_DIR, "convergence-audit.md"))}\n`,
  );
}

await main();
