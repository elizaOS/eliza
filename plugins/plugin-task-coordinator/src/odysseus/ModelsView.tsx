// odysseus model catalog + picker + provider management (static/js/models.js +
// modelPicker.js + modelSort.js + providers.js). A model-browser panel: a
// provider rail (left) that lets you pick which provider to scan, a sort menu
// (Default / A→Z / Last used / Most used), and a catalogue body that mirrors
// the reworked modelPicker.js browse model:
//   • a search box (shown once a catalogue is large) that filters the whole
//     scanned catalogue FLAT — id / display / provider name — across groups;
//   • in browse mode, a Recent section (auto-tracked, last 5 picks) and a
//     Favorites section pinned on top (manual);
//   • below them, small catalogues list everything under one "All models"
//     header, while large catalogues (> BROWSE_ALL_LIMIT) group the remaining
//     models under collapsible PROVIDER headers (provider = the model-id slug,
//     e.g. `anthropic/…`, mapped to a display name), each with a chevron +
//     count and a domino expand on open;
//   • every row carries a per-model favorite dot (provider-logo when matched)
//     that toggles favorite with a transient pulse, plus the "+ Chat" /
//     "+ Image" action and a drag-handle affordance.
// Favorites / recent / usage / sort / collapse state persist locally exactly
// like odysseus (FAVORITES_KEY / RECENT_KEY / USAGE_KEY / SORT_KEY /
// COLLAPSE_KEY via readPref/writePref).
//
// elizaMapping: the model lists are wired to the REAL model catalogue via
// client.fetchModels(provider) — the same /api/models endpoint CompareView's
// dropdowns use, returning ProviderModelRecord[]. odysseus's catalogue is a
// server scan that returns endpoint-grouped items with category (local vs api)
// and per-endpoint online/offline state; eliza's fetchModels returns a FLAT
// ProviderModelRecord[] ({ id, name, category }) per provider, with NO endpoint
// identity and NO online/offline signal — its `category` is the model modality
// (chat / image / embedding / …), not odysseus's local-vs-API axis. So the rail
// picks a PROVIDER (not an endpoint), and the in-body grouping is by the model
// id's slug (modelPicker.js _providerSlug / _providerDisplayName), faithful to
// upstream's provider-grouped browse. odysseus's Local/API category headers and
// per-endpoint collapsible sub-groups (models.js categoryOrder / multiEndpoints /
// endpoint-offline-badge) are deliberately NOT reproduced: the underlying
// endpoint/category(local-vs-api)/offline data does not exist in eliza's
// contract, and synthesising it would be fabricated UI. The COLLAPSE_KEY group
// keys are `ep:<provider>:<slug>` (real, used by the provider groups). Favorites
// + recent + usage tracking are per-browser localStorage, never agent state.
// odysseus's true model-switch (createDirectChat) starts a new session against a
// specific endpoint URL; eliza has no per-model session-spawn client method (the
// agent runs one configured model), so the "+ Chat" action records local usage +
// recent + emits a DOM event a host can wire later, and never fabricates a
// started session. Providers eliza has no key configured for return the faithful
// empty state ("No models available") rather than seeded/representative rows.

import type { ProviderModelRecord } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { ChevronDown, GripVertical, Search } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { useEscapeClose } from "./hooks/useEscapeClose";
import { useWindowControls } from "./hooks/useWindowControls";
import { ResizeHandles } from "./ResizeHandles";
import { LoadingRow } from "./Spinner";
import { readPref, writePref } from "./util/storage";

// ── Local-pref keys (odysseus models.js / modelPicker.js constants, namespaced
// via readPref) ──
const FAVORITES_KEY = "model-favorites";
const RECENT_KEY = "model-recent";
const USAGE_KEY = "model-usage";
const SORT_KEY = "model-sort";
const COLLAPSE_KEY = "models-collapsed";

// ── Provider scan keys (real /api/models fetch keys, mirrors CompareView) ──
const PROVIDERS = [
  "openai",
  "anthropic",
  "google",
  "openrouter",
  "groq",
  "xai",
  "ollama",
] as const;

type Provider = (typeof PROVIDERS)[number];

// ── Sort modes (odysseus models.js _getSortMode values) ──
type SortMode = "" | "alpha" | "last-used" | "most-used";

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: "", label: "Default" },
  { value: "alpha", label: "A → Z" },
  { value: "last-used", label: "Last used" },
  { value: "most-used", label: "Most used" },
];

// Up to MAX_VISIBLE models render eagerly per provider group; the rest sit
// behind "Show N more" (odysseus models.js MAX_VISIBLE = 5).
const MAX_VISIBLE = 5;
// Search box only appears once a scan exposes this many models
// (odysseus models.js totalModelCount >= 10 gate).
const SEARCH_THRESHOLD = 10;
// Recent tracks the last RECENT_MAX picks, most-recent-first
// (modelPicker.js RECENT_MAX = 5).
const RECENT_MAX = 5;
// Catalogues at or below this size list everything under one "All models"
// header; larger ones fall back to collapsible provider groups
// (modelPicker.js BROWSE_ALL_LIMIT = 12).
const BROWSE_ALL_LIMIT = 12;

interface UsageEntry {
  count: number;
  last: number;
}
type UsageMap = Record<string, UsageEntry>;

// ── Provider display names + slug grouping (modelPicker.js _PROVIDER_NAMES /
// _PROVIDER_ALIAS / _providerSlug / _providerDisplayName). The provider is the
// model-id slug before the first "/", aliased + prettified. Models with no
// slash fall under "other". ──
const PROVIDER_NAMES: Record<string, string> = {
  "01-ai": "Yi",
  abacusai: "Abacus AI",
  adept: "Adept",
  ai21: "AI21 Labs",
  ai21labs: "AI21 Labs",
  "aion-labs": "Aion Labs",
  aisingapore: "AI Singapore",
  allenai: "Allen AI",
  amazon: "Amazon",
  "anthracite-org": "Anthracite",
  anthropic: "Anthropic",
  "arcee-ai": "Arcee AI",
  baai: "BAAI",
  baidu: "Baidu",
  bigcode: "BigCode",
  "black-forest-labs": "Black Forest Labs",
  bytedance: "ByteDance",
  "bytedance-seed": "ByteDance",
  cognitivecomputations: "Cognitive Computations",
  cohere: "Cohere",
  databricks: "Databricks",
  deepcogito: "DeepCogito",
  deepseek: "DeepSeek",
  "deepseek-ai": "DeepSeek",
  essentialai: "Essential AI",
  google: "Google",
  gryphe: "Gryphe",
  ibm: "IBM",
  "ibm-granite": "IBM Granite",
  inception: "Inception",
  inclusionai: "Inclusion AI",
  inflection: "Inflection",
  kwaipilot: "KwaiPilot",
  liquid: "Liquid AI",
  mancer: "Mancer",
  meta: "Llama",
  "meta-llama": "Llama",
  microsoft: "Microsoft",
  minimax: "MiniMax",
  minimaxai: "MiniMax",
  mistralai: "Mistral",
  moonshotai: "Moonshot",
  morph: "Morph",
  "nex-agi": "Nex AGI",
  nousresearch: "Nous Research",
  "nv-mistralai": "NVIDIA x Mistral",
  nvidia: "NVIDIA",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  perceptron: "Perceptron",
  perplexity: "Perplexity",
  poolside: "Poolside",
  "prime-intellect": "Prime Intellect",
  qwen: "Qwen",
  rekaai: "Reka",
  relace: "Relace",
  sao10k: "Sao10k",
  sarvamai: "Sarvam AI",
  snowflake: "Snowflake",
  stepfun: "StepFun",
  "stepfun-ai": "StepFun",
  stockmark: "Stockmark",
  switchpoint: "SwitchPoint",
  tencent: "Tencent",
  thedrummer: "TheDrummer",
  undi95: "Undi95",
  upstage: "Upstage",
  writer: "Writer",
  "x-ai": "xAI",
  xiaomi: "Xiaomi",
  "z-ai": "Zhipu",
  zyphra: "Zyphra",
  "~anthropic": "Anthropic",
  "~google": "Google",
  "~moonshotai": "Moonshot",
  "~openai": "OpenAI",
};

const PROVIDER_ALIAS: Record<string, string> = {
  "meta-llama": "meta",
  deepseek: "deepseek-ai",
  minimaxai: "minimax",
  "stepfun-ai": "stepfun",
  ai21labs: "ai21",
  "ibm-granite": "ibm",
  "bytedance-seed": "bytedance",
  "~anthropic": "anthropic",
  "~google": "google",
  "~moonshotai": "moonshotai",
  "~openai": "openai",
};

/** modelPicker.js `_providerDisplayName`: prettify a slug to a label. */
function providerDisplayName(slug: string): string {
  const known = PROVIDER_NAMES[slug];
  if (known) return known;
  return slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");
}

/** modelPicker.js `_providerSlug`: the id prefix before "/", aliased. */
function providerSlug(modelId: string): string {
  const slash = modelId.indexOf("/");
  const raw = slash > 0 ? modelId.substring(0, slash) : "other";
  return PROVIDER_ALIAS[raw] ?? raw;
}

// ── Provider-scan-key → brand label (providers.js display names). The rail keys
// are the /api/models fetch keys ("openai", "xai", …); some differ from the
// PROVIDER_NAMES slugs ("xai" vs "x-ai"). Map each to the canonical brand label
// (OpenAI, xAI, OpenRouter, Ollama, …) so casing comes from data, not CSS. ──
const RAIL_SLUG_ALIAS: Record<Provider, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  openrouter: "openrouter",
  groq: "groq",
  xai: "x-ai",
  ollama: "ollama",
};

/** Brand-correct label for a provider-scan key (rail + header). */
function providerRailLabel(p: Provider): string {
  return providerDisplayName(RAIL_SLUG_ALIAS[p]);
}

// ── Provider-logo regex table (odysseus static/js/providers.js _PROVIDERS),
// returning an SVG path-set keyed by a regex over the model id. Kept inline so
// the model dot mirrors odysseus exactly without depending on @elizaos/ui's
// provider registry (which has a different contract). ──
interface LogoDef {
  re: RegExp;
  paths: ReactNode;
  fill: boolean;
}

const PROVIDER_LOGOS: LogoDef[] = [
  {
    re: /openai|gpt-|^o[13]-|chatgpt|dall-e/i,
    fill: true,
    paths: (
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 10.696.453a6.023 6.023 0 0 0-5.75 4.172 6.061 6.061 0 0 0-3.946 2.945 6.024 6.024 0 0 0 .742 7.099 5.98 5.98 0 0 0 .516 4.911 6.046 6.046 0 0 0 6.51 2.9A5.996 5.996 0 0 0 13.26 23.547a6.023 6.023 0 0 0 5.75-4.172 6.061 6.061 0 0 0 3.946-2.945 6.024 6.024 0 0 0-.674-6.609zM13.26 21.047a4.508 4.508 0 0 1-2.886-1.041l.143-.082 4.793-2.769a.777.777 0 0 0 .391-.676V10.34l2.026 1.17a.072.072 0 0 1 .039.061v5.596a4.532 4.532 0 0 1-4.506 4.48zM3.968 17.64a4.473 4.473 0 0 1-.537-3.018l.143.086 4.793 2.769a.79.79 0 0 0 .782 0l5.852-3.379v2.34a.072.072 0 0 1-.029.062l-4.845 2.796a4.532 4.532 0 0 1-6.159-1.656zM2.804 7.922a4.49 4.49 0 0 1 2.348-1.973V11.6a.778.778 0 0 0 .391.676l5.852 3.378-2.026 1.17a.072.072 0 0 1-.068 0L4.456 14.03a4.532 4.532 0 0 1-1.652-6.108zm16.423 3.823L13.375 8.367l2.026-1.17a.072.072 0 0 1 .068 0l4.845 2.796a4.525 4.525 0 0 1-.7 8.08V12.42a.778.778 0 0 0-.387-.676zm2.015-3.025l-.143-.086-4.793-2.769a.79.79 0 0 0-.782 0L9.672 9.243V6.903a.072.072 0 0 1 .029-.062l4.845-2.796a4.525 4.525 0 0 1 6.696 4.675zM8.598 12.66L6.57 11.49a.072.072 0 0 1-.039-.061V5.833a4.525 4.525 0 0 1 7.413-3.48l-.143.082-4.793 2.769a.777.777 0 0 0-.391.676l-.019 6.78zm1.1-2.379l2.607-1.505 2.607 1.505v3.01l-2.607 1.505-2.607-1.505z" />
    ),
  },
  {
    re: /openrouter|open router/i,
    fill: false,
    paths: (
      <>
        <circle cx="5" cy="12" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
        <path d="M7.5 12h4.5c2 0 2.5-6 4.5-6" />
        <path d="M12 12c2 0 2.5 6 4.5 6" />
      </>
    ),
  },
  {
    re: /anthropic|claude/i,
    fill: true,
    paths: (
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    ),
  },
  {
    re: /google|gemini|gemma/i,
    fill: true,
    paths: (
      <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
    ),
  },
  {
    re: /meta|llama(?![.\-_ ]?cpp)/i,
    fill: true,
    paths: (
      <path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z" />
    ),
  },
  {
    re: /mistral/i,
    fill: true,
    paths: (
      <path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" />
    ),
  },
  {
    re: /deepseek/i,
    fill: true,
    paths: (
      <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z" />
    ),
  },
  {
    re: /x-ai|xai|grok/i,
    fill: true,
    paths: (
      <path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z" />
    ),
  },
  {
    re: /ollama|:11434/i,
    fill: true,
    paths: (
      <path d="M12 2.5c-3.1 0-5.65 2.43-5.86 5.48A6.62 6.62 0 0 0 3 13.62C3 18 6.8 21.5 12 21.5s9-3.5 9-7.88a6.62 6.62 0 0 0-3.14-5.64C17.65 4.93 15.1 2.5 12 2.5Zm-2.7 8.25a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Zm5.4 0a1.15 1.15 0 1 1 0 2.3 1.15 1.15 0 0 1 0-2.3Zm-5.15 5.15c.75.7 1.55 1.04 2.45 1.04s1.7-.34 2.45-1.04c.26-.24.66-.23.9.03.24.26.23.66-.03.9-.98.91-2.08 1.37-3.32 1.37s-2.34-.46-3.32-1.37a.64.64 0 0 1-.03-.9.64.64 0 0 1 .9-.03Z" />
    ),
  },
  {
    re: /groq/i,
    fill: true,
    paths: (
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3.2a4.8 4.8 0 0 1 0 9.6h-1.5v2.6a.8.8 0 0 1-1.6 0V9.9a4.8 4.8 0 0 1 3.1-4.7zm0 1.6a3.2 3.2 0 0 0-1.5 6V6.9c.5-.07 1-.07 1.5-.1z" />
    ),
  },
];

/** Returns the matching provider logo SVG, or null (odysseus providerLogo). */
function providerLogo(modelId: string): ReactNode {
  if (!modelId) return null;
  for (const def of PROVIDER_LOGOS) {
    if (def.re.test(modelId)) {
      return (
        <svg
          viewBox="0 0 24 24"
          fill={def.fill ? "currentColor" : "none"}
          stroke={def.fill ? undefined : "currentColor"}
          strokeWidth={def.fill ? undefined : 2}
          strokeLinecap={def.fill ? undefined : "round"}
          strokeLinejoin={def.fill ? undefined : "round"}
          role="img"
          aria-label="Provider"
        >
          {def.paths}
        </svg>
      );
    }
  }
  return null;
}

/** odysseus modelSort.js `_sortText`: trailing path segment, trimmed. */
function sortText(value: string): string {
  return value.split("/").pop()?.trim() || value;
}

/** Last-used epoch for a model id (0 when never used). odysseus usage[mid].last. */
function lastUsed(usage: UsageMap, id: string): number {
  const entry = usage[id];
  return entry ? entry.last : 0;
}

/** Use-count for a model id (0 when never used). odysseus usage[mid].count. */
function countFor(usage: UsageMap, id: string): number {
  const entry = usage[id];
  return entry ? entry.count : 0;
}

/** odysseus modelSort.js `_compareText`: numeric, case-insensitive. */
function compareModels(a: ProviderModelRecord, b: ProviderModelRecord): number {
  const opts: Intl.CollatorOptions = { numeric: true, sensitivity: "base" };
  return (
    sortText(a.name).localeCompare(sortText(b.name), undefined, opts) ||
    a.name.localeCompare(b.name, undefined, opts)
  );
}

/** Short display name: trailing path segment (odysseus displayName.split('/').pop()). */
function shortName(name: string): string {
  return name.split("/").pop() || name;
}

export function ModelsView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  useEscapeClose(open, onClose);
  const win = useWindowControls("win-models", { w: 820, h: 720 });

  const [provider, setProvider] = useState<Provider>("openai");
  const [modelsByProvider, setModelsByProvider] = useState<
    Record<string, ProviderModelRecord[]>
  >({});
  const [errored, setErrored] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [loadingProvider, setLoadingProvider] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [usage, setUsage] = useState<UsageMap>({});
  const [sortMode, setSortMode] = useState<SortMode>("");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [shownAll, setShownAll] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [justExpanded, setJustExpanded] = useState<string | null>(null);
  const [pulsing, setPulsing] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [query, setQuery] = useState("");

  const loadProvider = useCallback(
    (prov: string) => {
      if (modelsByProvider[prov]) return;
      setLoadingProvider(prov);
      void client
        .fetchModels(prov)
        .then((r) => {
          setModelsByProvider((prev) => ({ ...prev, [prov]: r.models }));
        })
        .catch(() => {
          setModelsByProvider((prev) => ({ ...prev, [prov]: [] }));
          setErrored((prev) => {
            const next = new Set(prev);
            next.add(prov);
            return next;
          });
        })
        .finally(() => {
          setLoadingProvider((cur) => (cur === prov ? null : cur));
        });
    },
    [modelsByProvider],
  );

  // Hydrate local prefs + scan the default provider on open.
  useEffect(() => {
    if (!open) return;
    setFavorites(readPref<string[]>(FAVORITES_KEY, []));
    setRecent(readPref<string[]>(RECENT_KEY, []));
    setUsage(readPref<UsageMap>(USAGE_KEY, {}));
    setSortMode(readPref<SortMode>(SORT_KEY, ""));
    setCollapsed(readPref<Record<string, boolean>>(COLLAPSE_KEY, {}));
    loadProvider("openai");
  }, [open, loadProvider]);

  if (!open) return null;

  const persistFavorites = (next: string[]) => {
    setFavorites(next);
    writePref(FAVORITES_KEY, next);
  };

  // modelPicker.js `_toggleFavorite` + the favorite-dot polish: toggle the
  // favorite, flash the dot (transient pulse), and surface a transient toast
  // ("Favorited" / "Unfavorited"), mirroring uiModule.showToast upstream.
  const toggleFavorite = (mid: string) => {
    const idx = favorites.indexOf(mid);
    const nowFav = idx < 0;
    persistFavorites(
      nowFav ? [...favorites, mid] : favorites.filter((x) => x !== mid),
    );
    setPulsing(mid);
    window.setTimeout(() => {
      setPulsing((cur) => (cur === mid ? null : cur));
    }, 340);
    setFeedback(nowFav ? "Favorited" : "Unfavorited");
    window.setTimeout(() => {
      setFeedback((cur) =>
        cur === (nowFav ? "Favorited" : "Unfavorited") ? "" : cur,
      );
    }, 1400);
  };

  // odysseus models.js `_trackUsage` + modelPicker.js `_pushRecent` — bump
  // count, stamp last-used, and unshift onto Recent (deduped, capped). The
  // actual model-switch (createDirectChat) has no eliza client equivalent, so
  // this only records local state + broadcasts a DOM event a host can wire.
  const trackUsage = (mid: string) => {
    const nextUsage: UsageMap = { ...usage };
    const entry = nextUsage[mid] ?? { count: 0, last: 0 };
    nextUsage[mid] = { count: entry.count + 1, last: Date.now() };
    setUsage(nextUsage);
    writePref(USAGE_KEY, nextUsage);

    const nextRecent = [mid, ...recent.filter((x) => x !== mid)].slice(
      0,
      RECENT_MAX,
    );
    setRecent(nextRecent);
    writePref(RECENT_KEY, nextRecent);

    if (typeof document !== "undefined") {
      document.dispatchEvent(
        new CustomEvent("odysseus:model-picked", {
          detail: { provider, modelId: mid },
        }),
      );
    }
  };

  const pickSort = (mode: SortMode) => {
    setSortMode(mode);
    writePref(SORT_KEY, mode);
    setSortMenuOpen(false);
  };

  const isCollapsed = (key: string): boolean => collapsed[key] === true;

  const toggleCollapse = (key: string) => {
    const next = { ...collapsed, [key]: !isCollapsed(key) };
    setCollapsed(next);
    writePref(COLLAPSE_KEY, next);
    // Domino-expand the group when it opens (modelPicker.js _justExpanded).
    setJustExpanded(next[key] ? null : key);
  };

  // odysseus models.js sort dispatch — apply the active sort mode to a list.
  const applySort = (list: ProviderModelRecord[]): ProviderModelRecord[] => {
    const copy = list.slice();
    if (sortMode === "alpha") {
      copy.sort(compareModels);
    } else if (sortMode === "last-used") {
      copy.sort((a, b) => lastUsed(usage, b.id) - lastUsed(usage, a.id));
    } else if (sortMode === "most-used") {
      copy.sort((a, b) => countFor(usage, b.id) - countFor(usage, a.id));
    }
    return copy;
  };

  const allModels = modelsByProvider[provider] ?? [];
  const isLoading = loadingProvider === provider && !modelsByProvider[provider];
  const isErrored = errored.has(provider);
  const hasModels = allModels.length > 0;

  const byId = new Map<string, ProviderModelRecord>();
  for (const m of allModels) {
    if (!byId.has(m.id)) byId.set(m.id, m);
  }

  // Sorted catalogue + flat search. Search mirrors modelPicker.js search mode:
  // match id / display / provider name, case-insensitive, across all groups.
  const sorted = applySort(allModels);
  const q = query.toLowerCase().trim();
  const searchMatches = q
    ? sorted.filter((m) =>
        [m.id, m.name, providerDisplayName(providerSlug(m.id))]
          .join(" ")
          .toLowerCase()
          .includes(q),
      )
    : [];

  // Browse mode (modelPicker.js _populate): Recent (auto) + Favorites (manual)
  // pinned on top, then either a flat "All models" list (small catalogues) or
  // collapsible provider groups (large catalogues). Pinned ids are deduped out
  // of the lower lists.
  const recentModels = recent
    .map((id) => byId.get(id))
    .filter((m): m is ProviderModelRecord => m !== undefined)
    .slice(0, RECENT_MAX);
  const favModels = favorites
    .map((id) => byId.get(id))
    .filter((m): m is ProviderModelRecord => m !== undefined);

  const pinnedIds = new Set<string>([
    ...recentModels.map((m) => m.id),
    ...favModels.map((m) => m.id),
  ]);
  const rest = sorted.filter((m) => !pinnedIds.has(m.id));

  // Large catalogue → provider-slug groups, ordered by display name.
  const providerGroups: { slug: string; models: ProviderModelRecord[] }[] =
    (() => {
      const groups = new Map<string, ProviderModelRecord[]>();
      for (const m of rest) {
        const slug = providerSlug(m.id);
        const bucket = groups.get(slug);
        if (bucket) bucket.push(m);
        else groups.set(slug, [m]);
      }
      return [...groups.keys()]
        .sort((a, b) =>
          providerDisplayName(a).localeCompare(providerDisplayName(b)),
        )
        .map((slug) => {
          const models = groups.get(slug);
          return { slug, models: models ?? [] };
        });
    })();

  const isLargeCatalogue = allModels.length > BROWSE_ALL_LIMIT;
  const showSearch = allModels.length >= SEARCH_THRESHOLD;
  const hasPinned = recentModels.length > 0 || favModels.length > 0;

  const sortLabel =
    SORT_OPTIONS.find((o) => o.value === sortMode)?.label ?? "Default";

  const renderRow = (m: ProviderModelRecord): ReactNode => {
    const logo = providerLogo(m.id);
    const isFav = favorites.includes(m.id);
    const isImage = m.category === "image";
    return (
      <div className="od-models-row" data-model-id={m.id} key={m.id}>
        <span
          className="od-models-drag"
          title="Drag to reorder"
          aria-hidden="true"
        >
          <GripVertical size={11} />
        </span>
        <button
          type="button"
          className={`od-model-fav-btn${logo ? " od-provider-logo" : ""}${isFav ? " active" : ""}${pulsing === m.id ? " od-fav-pulse" : ""}`}
          title={isFav ? "Remove from favorites" : "Add to favorites"}
          aria-label={isFav ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={isFav}
          onClick={() => toggleFavorite(m.id)}
        >
          {logo}
        </button>
        <span className="od-models-grow">
          {shortName(m.name)}
          {isImage ? (
            <span
              className="od-model-type-badge"
              title="Image generation model"
            >
              IMG
            </span>
          ) : null}
        </span>
        <button
          type="button"
          className="od-model-chat-btn"
          onClick={() => trackUsage(m.id)}
        >
          {isImage ? "+ Image" : "+ Chat"}
        </button>
      </div>
    );
  };

  // Pinned Recent / Favorites sections (modelPicker.js _addSection) — a flat
  // labelled list, no collapse.
  const renderPinned = (
    label: string,
    list: ProviderModelRecord[],
  ): ReactNode =>
    list.length > 0 ? (
      <>
        <div className="od-models-section-label">{label}</div>
        <div className="od-models-group-content">{list.map(renderRow)}</div>
      </>
    ) : null;

  // A collapsible provider group (modelPicker.js mp-provider-header +
  // mp-provider-group). Capped at MAX_VISIBLE behind a "Show N more".
  const renderProviderGroup = (
    slug: string,
    models: ProviderModelRecord[],
  ): ReactNode => {
    const key = `ep:${provider}:${slug}`;
    const groupCollapsed = isCollapsed(key);
    const seeAll = shownAll.has(key);
    const visible = seeAll ? models : models.slice(0, MAX_VISIBLE);
    const overflow = models.length - visible.length;
    return (
      <div key={slug}>
        <button
          type="button"
          className="od-models-provider-header"
          onClick={() => toggleCollapse(key)}
        >
          <span
            className={`od-models-provider-chevron${groupCollapsed ? " collapsed" : ""}`}
            aria-hidden="true"
          >
            <ChevronDown size={11} />
          </span>
          <span className="od-models-provider-group-name">
            {providerDisplayName(slug)}
          </span>
          <span className="od-models-provider-group-count">
            {models.length}
          </span>
        </button>
        {groupCollapsed ? null : (
          <div
            className={`od-models-group-content indented${justExpanded === key ? " od-just-expanded" : ""}`}
          >
            {visible.map(renderRow)}
            {overflow > 0 ? (
              <button
                type="button"
                className="od-models-show-all-btn"
                onClick={() =>
                  setShownAll((prev) => {
                    const next = new Set(prev);
                    next.add(key);
                    return next;
                  })
                }
              >
                Show {overflow} more model{overflow === 1 ? "" : "s"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`od-search-overlay${win.windowed ? " od-windowed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Models"
    >
      <button
        type="button"
        aria-label="Close models"
        onClick={onClose}
        className="od-search-backdrop"
      />
      <div className="od-search-panel od-models-panel" style={win.panelStyle}>
        <ResizeHandles controls={win} />
        <div
          className="od-mem-head od-window-header"
          onPointerDown={win.onDragStart}
        >
          <span className="od-mem-title">Models</span>
          {feedback ? (
            <span className="od-models-feedback" role="status">
              {feedback}
            </span>
          ) : null}
          <span className="od-mem-stats">
            {hasModels
              ? `${allModels.length} model${allModels.length === 1 ? "" : "s"} · ${providerRailLabel(provider)}`
              : providerRailLabel(provider)}
          </span>
        </div>

        <div className="od-models-body">
          {/* ── Provider rail (providers.js — pick which provider to scan) ── */}
          <div className="od-models-providers">
            <div className="od-models-providers-head">Providers</div>
            {PROVIDERS.map((p) => {
              const list = modelsByProvider[p];
              const count = list ? list.length : null;
              return (
                <button
                  type="button"
                  key={p}
                  className={`od-models-provider-row${p === provider ? " active" : ""}`}
                  onClick={() => {
                    setProvider(p);
                    setQuery("");
                    setShownAll(new Set<string>());
                    setJustExpanded(null);
                    loadProvider(p);
                  }}
                >
                  <span className="od-models-provider-name">
                    {providerRailLabel(p)}
                  </span>
                  {count !== null ? (
                    <span className="od-models-provider-count">{count}</span>
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* ── Catalogue (#models box) ── */}
          <div className="od-models-list">
            <div className="od-models-toolbar">
              <div className="od-models-sort-wrap">
                <button
                  type="button"
                  className="od-models-sort-btn"
                  title="Sort models"
                  onClick={() => setSortMenuOpen((v) => !v)}
                >
                  <span>{sortLabel}</span>
                  <ChevronDown size={12} />
                </button>
                {sortMenuOpen ? (
                  <div className="od-models-sort-menu" role="menu">
                    {SORT_OPTIONS.map((o) => (
                      <button
                        type="button"
                        key={o.value || "default"}
                        className={`od-models-sort-item${o.value === sortMode ? " current" : ""}`}
                        onClick={() => pickSort(o.value)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            {showSearch ? (
              <div className="od-models-search-row">
                <Search size={13} className="od-models-search-icon" />
                <input
                  className="od-model-search-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      if (query) setQuery("");
                      else onClose();
                    }
                  }}
                  placeholder="Search models…"
                  aria-label="Search models"
                />
              </div>
            ) : null}

            <div className="od-models-scroll">
              {isLoading ? (
                <LoadingRow
                  label={`Scanning ${providerRailLabel(provider)}…`}
                />
              ) : isErrored ? (
                <div className="od-models-empty-state">
                  <span className="od-models-muted">
                    Couldn't reach {providerRailLabel(provider)}
                  </span>
                  <br />
                  <button
                    type="button"
                    className="od-models-retry-link"
                    onClick={() => {
                      setErrored((prev) => {
                        const next = new Set(prev);
                        next.delete(provider);
                        return next;
                      });
                      setModelsByProvider((prev) => {
                        const next = { ...prev };
                        delete next[provider];
                        return next;
                      });
                      loadProvider(provider);
                    }}
                  >
                    Retry scan
                  </button>
                </div>
              ) : !hasModels ? (
                <div className="od-models-empty-state">
                  <span className="od-models-muted">No models available</span>
                  <br />
                  <span className="od-models-muted-sm">
                    Configure a {providerRailLabel(provider)} API key in
                    Settings to scan models.
                  </span>
                </div>
              ) : q ? (
                /* ── Search mode: flat, filtered results across the catalogue ── */
                searchMatches.length === 0 ? (
                  <div className="od-models-empty-state">
                    <span className="od-models-muted">
                      No models match "{query.trim()}"
                    </span>
                  </div>
                ) : (
                  <div className="od-models-group-content">
                    {searchMatches.map(renderRow)}
                  </div>
                )
              ) : (
                /* ── Browse mode: Recent + Favorites, then All / provider groups ── */
                <>
                  {renderPinned("Recent", recentModels)}
                  {renderPinned("Favorites", favModels)}

                  {rest.length > 0 ? (
                    isLargeCatalogue ? (
                      providerGroups.map((g) =>
                        renderProviderGroup(g.slug, g.models),
                      )
                    ) : (
                      <>
                        {hasPinned ? (
                          <div className="od-models-section-label">
                            All models
                          </div>
                        ) : null}
                        <div className="od-models-group-content">
                          {rest.map(renderRow)}
                        </div>
                      </>
                    )
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
