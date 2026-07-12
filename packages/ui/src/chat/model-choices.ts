/**
 * Position-aware completion values for the "models" dynamic arg source, derived
 * from the `catalog` field of `GET /api/models` (the same catalog
 * `POST /api/models/config` validates writes against). Pure functions so the
 * grammar can be unit-tested without React: `useSlashCommandController`
 * pre-fetches the catalog into state and delegates here per keystroke.
 *
 * The `/model` grammar this mirrors (plugin-commands actions/model-config.ts):
 *   /model <target|model>                      target ∈ small|large|coding|show|local|cloud
 *   /model small|large [provider] <model> [effort]
 *   /model coding <backend> <model> [effort]
 * Values must be single whitespace-free tokens (the menu's completion rejoins
 * tokens with spaces). A model served by more than one chat provider is offered
 * as `provider/id` so picking it can never hit the route's ambiguous-provider
 * 400; unique ids stay bare.
 */

import type {
  ModelCatalogEntry,
  ModelCatalogProviders,
} from "../api/client-types-core";
import type { SlashArgChoiceContext } from "./slash-menu";

/** Keeps the arg menu scannable when a provider catalog grows. */
const MAX_MODEL_CHOICES = 25;

type ChatTarget = "small" | "large";

/** Backend tokens `/model coding <backend>` accepts, in suggestion order. */
export const CODING_BACKEND_CHOICES = [
  "codex",
  "claude",
  "opencode",
  "elizaos",
] as const;

// Catalog provider that carries each backend's model list; opencode/elizaos
// take free-form model ids, so they get no completion source.
const CODING_BACKEND_CATALOG_PROVIDER: Record<string, string> = {
  codex: "codex",
  claude: "claude-coding",
};

function isChatTarget(token: string | undefined): token is ChatTarget {
  return token === "small" || token === "large";
}

function callable(entry: ModelCatalogEntry): boolean {
  return entry.apiSupported !== false;
}

function cap(values: string[]): string[] {
  return values.slice(0, MAX_MODEL_CHOICES);
}

function allModelIds(providers: ModelCatalogProviders): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const entries of Object.values(providers)) {
    for (const entry of entries) {
      if (!callable(entry) || seen.has(entry.id)) continue;
      seen.add(entry.id);
      ids.push(entry.id);
    }
  }
  return ids;
}

function chatEntries(
  providers: ModelCatalogProviders,
  target: ChatTarget,
): Array<{ provider: string; entry: ModelCatalogEntry }> {
  const matches: Array<{ provider: string; entry: ModelCatalogEntry }> = [];
  for (const [provider, entries] of Object.entries(providers)) {
    for (const entry of entries) {
      if (callable(entry) && entry.roles.includes(target)) {
        matches.push({ provider, entry });
      }
    }
  }
  return matches;
}

/**
 * Chat model values for a target: bare id when one provider serves it,
 * `provider/id` per serving provider otherwise (deterministic writes — the
 * config route 400s on an ambiguous bare id).
 */
function chatModelValues(
  providers: ModelCatalogProviders,
  target: ChatTarget,
): string[] {
  const matches = chatEntries(providers, target);
  const providerCount = new Map<string, number>();
  for (const { entry } of matches) {
    providerCount.set(entry.id, (providerCount.get(entry.id) ?? 0) + 1);
  }
  const values: string[] = [];
  const seen = new Set<string>();
  for (const { provider, entry } of matches) {
    const value =
      (providerCount.get(entry.id) ?? 0) > 1
        ? `${provider}/${entry.id}`
        : entry.id;
    if (seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }
  return values;
}

function providerModelIds(
  providers: ModelCatalogProviders,
  provider: string,
  target?: ChatTarget,
): string[] {
  const entries = providers[provider] ?? [];
  return entries
    .filter(
      (entry) => callable(entry) && (!target || entry.roles.includes(target)),
    )
    .map((entry) => entry.id);
}

/** Union of effort levels in first-seen order across the given entries. */
function effortUnion(entries: ModelCatalogEntry[]): string[] {
  const efforts: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    for (const effort of entry.efforts) {
      if (seen.has(effort)) continue;
      seen.add(effort);
      efforts.push(effort);
    }
  }
  return efforts;
}

/**
 * Entries a chat-target model token names: a `provider/id` value narrows to
 * that provider; a bare id matches every chat provider serving it.
 */
function chatEntriesForToken(
  providers: ModelCatalogProviders,
  target: ChatTarget,
  token: string,
): ModelCatalogEntry[] {
  const slash = token.indexOf("/");
  const prefix = slash > 0 ? token.slice(0, slash).toLowerCase() : "";
  if (prefix && providers[prefix]) {
    const id = token.slice(slash + 1);
    return (providers[prefix] ?? []).filter(
      (entry) => entry.id === id && entry.roles.includes(target),
    );
  }
  return chatEntries(providers, target)
    .filter(({ entry }) => entry.id === token)
    .map(({ entry }) => entry);
}

function isChatProviderToken(
  providers: ModelCatalogProviders,
  target: ChatTarget,
  token: string | undefined,
): boolean {
  if (!token) return false;
  const entries = providers[token.toLowerCase()];
  return entries?.some((entry) => entry.roles.includes(target)) ?? false;
}

function codingModelIds(
  providers: ModelCatalogProviders,
  backendToken: string | undefined,
): string[] {
  const provider =
    CODING_BACKEND_CATALOG_PROVIDER[backendToken?.toLowerCase() ?? ""];
  return provider ? providerModelIds(providers, provider) : [];
}

function codingEfforts(
  providers: ModelCatalogProviders,
  backendToken: string | undefined,
  modelToken: string | undefined,
): string[] {
  const provider =
    CODING_BACKEND_CATALOG_PROVIDER[backendToken?.toLowerCase() ?? ""];
  if (!provider || !modelToken) return [];
  const entry = (providers[provider] ?? []).find((e) => e.id === modelToken);
  return entry ? [...entry.efforts] : [];
}

/**
 * Resolve the completion values for a "models"-sourced argument. Without a
 * catalog there is nothing to offer; without positional context (a command
 * other than `/model` tagging the source) every callable model id is offered.
 */
export function resolveModelChoices(
  providers: ModelCatalogProviders | null,
  context: SlashArgChoiceContext | undefined,
): string[] {
  if (!providers) return [];
  if (context?.commandKey !== "model") {
    return cap(allModelIds(providers));
  }

  const first = context.precedingTokens[0]?.toLowerCase();
  switch (context.argIndex) {
    case 0:
      // The static target choices ride on the arg definition; the dynamic side
      // offers model ids for the pre-existing bare-name per-room preference.
      return cap(allModelIds(providers));

    case 1: {
      if (isChatTarget(first)) return cap(chatModelValues(providers, first));
      if (first === "coding") return [...CODING_BACKEND_CHOICES];
      return [];
    }

    case 2: {
      const second = context.precedingTokens[1] ?? "";
      if (isChatTarget(first)) {
        if (isChatProviderToken(providers, first, second)) {
          return cap(providerModelIds(providers, second.toLowerCase(), first));
        }
        return effortUnion(chatEntriesForToken(providers, first, second));
      }
      if (first === "coding") return cap(codingModelIds(providers, second));
      return [];
    }

    case 3: {
      const second = context.precedingTokens[1] ?? "";
      const third = context.precedingTokens[2] ?? "";
      if (isChatTarget(first)) {
        if (!isChatProviderToken(providers, first, second)) return [];
        return effortUnion(
          (providers[second.toLowerCase()] ?? []).filter(
            (entry) => entry.id === third && entry.roles.includes(first),
          ),
        );
      }
      if (first === "coding") return codingEfforts(providers, second, third);
      return [];
    }

    default:
      return [];
  }
}

// Row labels for /model's static target/backend tokens; catalog-derived model
// values get their display name (plus provider for qualified values).
const STATIC_MODEL_CHOICE_LABELS: ReadonlyArray<[string, string]> = [
  ["small", "small chat model (global)"],
  ["large", "large chat model (global)"],
  ["coding", "coding sub-agent model (global)"],
  ["show", "current model configuration"],
  ["local", "on-device inference"],
  ["cloud", "Eliza Cloud inference"],
  ["codex", "Codex CLI"],
  ["claude", "Claude Code"],
  ["opencode", "OpenCode"],
  ["elizaos", "elizaOS coder"],
];

/**
 * Value→label map for every choice {@link resolveModelChoices} can emit, so
 * the menu can render a display name next to the raw completion token.
 */
export function buildModelChoiceLabels(
  providers: ModelCatalogProviders | null,
): Map<string, string> {
  const labels = new Map<string, string>(STATIC_MODEL_CHOICE_LABELS);
  if (!providers) return labels;
  for (const [provider, entries] of Object.entries(providers)) {
    for (const entry of entries) {
      const hint = entry.costHint ? ` — ${entry.costHint}` : "";
      if (!labels.has(entry.id)) {
        labels.set(entry.id, `${entry.display}${hint}`);
      }
      labels.set(
        `${provider}/${entry.id}`,
        `${entry.display} · ${provider}${hint}`,
      );
    }
  }
  return labels;
}
