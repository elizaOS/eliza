/**
 * Provider→model catalog powering user-configurable model selection: which
 * models each provider serves, which reasoning-effort levels each model
 * accepts, and which runtime roles (small / large chat brain, coding
 * sub-agent) a model may fill. `GET /api/models` attaches the catalog to its
 * response and `POST /api/models/config` (model-config-routes.ts) validates
 * every write against it — Codex in particular silently accepts invalid
 * `model_reasoning_effort` values, so this catalog is the only enforcement
 * seam.
 *
 * Codex entries are live-merged from `$CODEX_HOME/models_cache.json` (the
 * Codex CLI's cached server catalog) at call time, with the verified static
 * table below as the designed fallback when the cache is absent or corrupt.
 * Every other provider's list is static, verified ground truth: Anthropic
 * chat/coding model ids and effort gates, the Cerebras trio (zai-glm-4.7
 * exposes NO effort — its reasoning knob is unverified), and the Eliza Cloud
 * curated trio. Filesystem access is injectable so tests run hermetically.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";

export interface ModelCatalogEntry {
  id: string;
  display: string;
  /** Accepted reasoning-effort levels; empty = the model has no effort knob. */
  efforts: string[];
  defaultEffort?: string;
  roles: Array<"small" | "large" | "coding">;
  costHint?: string;
  /** false = listed by the provider but not callable via the API tier. */
  apiSupported?: boolean;
}

export interface ModelCatalog {
  providers: Record<string, ModelCatalogEntry[]>;
}

/**
 * User-approved default coding model per backend. Mirrors
 * `TASK_AGENT_DEFAULT_MODEL_PREFS` in
 * plugins/plugin-agent-orchestrator/src/services/task-agent-frameworks.ts —
 * keep the two in sync when the product default moves.
 */
export const CODING_MODEL_DEFAULTS: Readonly<Record<string, string>> = {
  codex: "gpt-5.6-sol",
  claude: "claude-opus-4-8",
};

// The ultra tier trades cost and latency for maximum reasoning + delegation;
// surfaced so clients can warn before a user pins it as their default.
const ULTRA_COST_HINT = "highest cost/latency tier";

const CODEX_STATIC_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gpt-5.6-sol",
    display: "GPT-5.6-Sol",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    roles: ["coding"],
    costHint: ULTRA_COST_HINT,
  },
  {
    id: "gpt-5.6-terra",
    display: "GPT-5.6-Terra",
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    defaultEffort: "medium",
    roles: ["coding"],
    costHint: ULTRA_COST_HINT,
  },
  {
    id: "gpt-5.6-luna",
    display: "GPT-5.6-Luna",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    roles: ["coding"],
  },
  {
    id: "gpt-5.5",
    display: "GPT-5.5",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    roles: ["coding"],
  },
  {
    id: "gpt-5.4",
    display: "GPT-5.4",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    roles: ["coding"],
  },
  {
    id: "gpt-5.4-mini",
    display: "GPT-5.4-Mini",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "medium",
    roles: ["coding"],
  },
  {
    id: "gpt-5.3-codex-spark",
    display: "GPT-5.3-Codex-Spark",
    efforts: ["low", "medium", "high", "xhigh"],
    defaultEffort: "high",
    roles: ["coding"],
    apiSupported: false,
  },
];

// Anthropic effort gate: xhigh/max only on opus >= 4.7 and fable-5; sonnets
// cap at high. Haiku takes NO chat-API effort at all — live-probed 2026-07-12,
// the Messages API answers "This model does not support the effort parameter"
// (and rejects adaptive thinking); the coding CLI's CLAUDE_CODE_EFFORT_LEVEL
// is a separate mechanism and keeps its low..high range there.
const CLAUDE_MODELS: Array<{
  id: string;
  display: string;
  full: boolean;
  chatEffort?: false;
}> = [
  { id: "claude-fable-5", display: "Claude Fable 5", full: true },
  { id: "claude-opus-4-8", display: "Claude Opus 4.8", full: true },
  { id: "claude-opus-4-7", display: "Claude Opus 4.7", full: true },
  { id: "claude-opus-4-6", display: "Claude Opus 4.6", full: false },
  { id: "claude-sonnet-5", display: "Claude Sonnet 5", full: false },
  { id: "claude-sonnet-4-6", display: "Claude Sonnet 4.6", full: false },
  {
    id: "claude-haiku-4-5-20251001",
    display: "Claude Haiku 4.5",
    full: false,
    chatEffort: false,
  },
];

function claudeEfforts(full: boolean): string[] {
  return full
    ? ["low", "medium", "high", "xhigh", "max"]
    : ["low", "medium", "high"];
}

const CLAUDE_CHAT_ENTRIES: ModelCatalogEntry[] = CLAUDE_MODELS.map((m) => ({
  id: m.id,
  display: m.display,
  efforts: m.chatEffort === false ? [] : claudeEfforts(m.full),
  roles: ["small", "large"],
}));

// Claude Code CLI defaults to xhigh (CLAUDE_CODE_EFFORT_LEVEL); models whose
// effort ceiling is high get no default rather than a fabricated one.
const CLAUDE_CODING_ENTRIES: ModelCatalogEntry[] = CLAUDE_MODELS.map((m) => ({
  id: m.id,
  display: m.display,
  efforts: claudeEfforts(m.full),
  ...(m.full ? { defaultEffort: "xhigh" } : {}),
  roles: ["coding"],
}));

// All three Cerebras-served models are reasoning models: `reasoning_effort`
// was live-probed 2026-07-12 and modulates the emitted reasoning on each
// (glm 90->1337 reasoning chars low->high; gemma 663->1133), so every entry
// carries the knob — not just gpt-oss.
const CEREBRAS_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gemma-4-31b",
    display: "Gemma 4 31B",
    efforts: ["low", "medium", "high"],
    roles: ["small"],
  },
  {
    id: "zai-glm-4.7",
    display: "GLM-4.7",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
  {
    id: "gpt-oss-120b",
    display: "GPT-OSS 120B",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
];

// Curated per product decision: exactly the Cerebras trio as served by Eliza
// Cloud (plus the `openai/` alias the cloud router also accepts) — nothing
// else until the cloud catalog is opened up.
const ELIZACLOUD_ENTRIES: ModelCatalogEntry[] = [
  {
    id: "gpt-oss-120b",
    display: "GPT-OSS 120B",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
  {
    id: "openai/gpt-oss-120b",
    display: "GPT-OSS 120B",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
  {
    id: "zai-glm-4.7",
    display: "GLM-4.7",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
  {
    id: "gemma-4-31b",
    display: "Gemma 4 31B",
    efforts: ["low", "medium", "high"],
    roles: ["small", "large"],
  },
];

export interface BuildModelCatalogOptions {
  /** Injectable file read for tests; defaults to fs.readFileSync utf-8. */
  readFile?: (filePath: string) => string;
  /** Injectable env for tests; defaults to process.env (CODEX_HOME lookup). */
  env?: NodeJS.ProcessEnv;
}

const EFFORT_LEVELS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const HIDDEN_VISIBILITIES = new Set(["hide", "hidden", "internal"]);

function clone(entry: ModelCatalogEntry): ModelCatalogEntry {
  return { ...entry, efforts: [...entry.efforts], roles: [...entry.roles] };
}

/**
 * Parse the Codex CLI's `models_cache.json` into catalog entries. Throws on a
 * malformed document (the caller falls back to the static table); individual
 * entries that lack a usable slug/effort list are skipped, and entries the
 * server marks hidden/internal are excluded from the user-facing catalog.
 */
function parseCodexModelsCache(raw: string): ModelCatalogEntry[] {
  const doc = JSON.parse(raw) as { models?: unknown };
  if (!Array.isArray(doc.models)) {
    throw new Error("models_cache.json has no models array");
  }
  const entries: ModelCatalogEntry[] = [];
  for (const item of doc.models) {
    if (!item || typeof item !== "object") continue;
    const m = item as {
      slug?: unknown;
      display_name?: unknown;
      default_reasoning_level?: unknown;
      supported_reasoning_levels?: unknown;
      visibility?: unknown;
      supported_in_api?: unknown;
    };
    if (typeof m.slug !== "string" || !m.slug.trim()) continue;
    if (
      typeof m.visibility === "string" &&
      HIDDEN_VISIBILITIES.has(m.visibility.toLowerCase())
    ) {
      continue;
    }
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? m.supported_reasoning_levels
          .map((level) =>
            level && typeof level === "object"
              ? (level as { effort?: unknown }).effort
              : undefined,
          )
          .filter(
            (effort): effort is string =>
              typeof effort === "string" && EFFORT_LEVELS.has(effort),
          )
      : [];
    if (efforts.length === 0) continue;
    const defaultEffort =
      typeof m.default_reasoning_level === "string" &&
      efforts.includes(m.default_reasoning_level)
        ? m.default_reasoning_level
        : undefined;
    entries.push({
      id: m.slug,
      display:
        typeof m.display_name === "string" && m.display_name.trim()
          ? m.display_name
          : m.slug,
      efforts,
      ...(defaultEffort ? { defaultEffort } : {}),
      roles: ["coding"],
      ...(efforts.includes("ultra") ? { costHint: ULTRA_COST_HINT } : {}),
      ...(m.supported_in_api === false ? { apiSupported: false } : {}),
    });
  }
  if (entries.length === 0) {
    throw new Error("models_cache.json contained no usable model entries");
  }
  return entries;
}

// Log the fallback once per process — the catalog is rebuilt per request and
// a missing cache on a box without the Codex CLI is a permanent condition.
let codexCacheFallbackLogged = false;

function buildCodexEntries(
  opts: BuildModelCatalogOptions,
): ModelCatalogEntry[] {
  const env = opts.env ?? process.env;
  const readFile =
    opts.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf-8"));
  const codexHome = env.CODEX_HOME?.trim()
    ? env.CODEX_HOME.trim()
    : path.join(os.homedir(), ".codex");
  const cachePath = path.join(codexHome, "models_cache.json");

  let cacheEntries: ModelCatalogEntry[];
  try {
    cacheEntries = parseCodexModelsCache(readFile(cachePath));
  } catch (err) {
    // error-policy:J4 the live Codex server catalog is an optional enrichment;
    // an absent or corrupt cache degrades to the verified static table by
    // design (this catalog must exist on boxes without the Codex CLI).
    if (!codexCacheFallbackLogged) {
      codexCacheFallbackLogged = true;
      logger.debug(
        `[ModelCatalog] codex models_cache.json unavailable at ${cachePath}; serving static codex catalog: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return CODEX_STATIC_ENTRIES.map(clone);
  }

  // Merge: the server catalog wins per model id; statically-known models the
  // cache omits are retained so a partial server catalog never shrinks the
  // verified baseline (spark stays listed with apiSupported:false).
  const merged = new Map<string, ModelCatalogEntry>(
    CODEX_STATIC_ENTRIES.map((entry) => [entry.id, clone(entry)]),
  );
  for (const entry of cacheEntries) merged.set(entry.id, entry);
  return [...merged.values()];
}

/**
 * Build the full provider→model catalog. Pure given its injected reads: the
 * only I/O is the Codex cache lookup, and callers get fresh copies so cached
 * static tables can never be mutated through a response object.
 */
export function buildModelCatalog(
  opts: BuildModelCatalogOptions = {},
): ModelCatalog {
  return {
    providers: {
      codex: buildCodexEntries(opts),
      "claude-chat": CLAUDE_CHAT_ENTRIES.map(clone),
      "claude-coding": CLAUDE_CODING_ENTRIES.map(clone),
      cerebras: CEREBRAS_ENTRIES.map(clone),
      elizacloud: ELIZACLOUD_ENTRIES.map(clone),
    },
  };
}
