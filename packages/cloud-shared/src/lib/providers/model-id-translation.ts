/**
 * Model ID translation between legacy canonical ids (gateway-style) and
 * OpenRouter's catalog format.
 *
 * **Why this module exists:** After OpenRouter became the primary text routing
 * path, the public catalog uses `x-ai/` and `mistralai/` prefixes while older
 * clients, saved settings, and some DB rows still use `xai/` and `mistral/`.
 * If we only compared strings literally, the same logical model would appear as
 * two analytics series, pricing would miss half the keys, and allowlists would
 * reject valid configurations. Centralizing translation + “candidate expansion”
 * keeps billing, usage, and catalog checks consistent without scattering ad hoc
 * `replace()` calls.
 *
 * Two providers diverge on prefix:
 *   - xAI:     legacy `xai/grok-4`        → OpenRouter `x-ai/grok-4`
 *   - Mistral: legacy `mistral/codestral` → OpenRouter `mistralai/codestral`
 *
 * All other providers (`openai/`, `anthropic/`, `google/`, `groq/`, …) share
 * the same prefix on both catalogs and pass through unchanged.
 *
 * @see docs/openrouter-model-id-compatibility.md for boundaries and SQL parity rules.
 */

const PREFIX_MAP: ReadonlyArray<readonly [string, string]> = [
  ["xai/", "x-ai/"],
  ["mistral/", "mistralai/"],
];

const PROVIDER_KEY_MAP: Readonly<Record<string, string>> = {
  "x-ai": "xai",
  mistralai: "mistral",
};

export function toOpenRouterModelId(model: string): string {
  for (const [from, to] of PREFIX_MAP) {
    if (model.startsWith(from)) {
      return `${to}${model.slice(from.length)}`;
    }
  }
  return model;
}

/**
 * Inverse of `toOpenRouterModelId`: maps OpenRouter ids back to the canonical
 * gateway-style id. Used for back-compat in pricing lookup keys when callers
 * still send the old `xai/`/`mistral/` shape.
 */
export function fromOpenRouterModelId(model: string): string {
  for (const [canonical, openrouter] of PREFIX_MAP) {
    if (model.startsWith(openrouter)) {
      return `${canonical}${model.slice(openrouter.length)}`;
    }
  }
  return model;
}

/**
 * Returns the requested model id together with its old/new spelling variants
 * (deduped, original first). Use this whenever a caller could be sending
 * either the gateway-style id or the OpenRouter id and lookup must match
 * either. Empty/blank ids return an empty array.
 *
 * **Why dedupe + order:** Callers iterate candidates in order; the original id
 * should win for logging and “resolved via alias” warnings. Skipping empty
 * strings avoids accidental matches on blank input.
 */
export function expandOpenRouterModelIdCandidates(model: string): string[] {
  const normalized = model.trim();
  if (!normalized) {
    return [];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  push(normalized);
  push(toOpenRouterModelId(normalized));
  push(fromOpenRouterModelId(normalized));
  return out;
}

/**
 * Maps OpenRouter prefix-derived provider keys (`x-ai`, `mistralai`) to the
 * logical provider keys used elsewhere in the app (`xai`, `mistral`). Other
 * provider strings pass through unchanged.
 *
 * **Why:** Usage rows and external payloads may still carry OpenRouter’s
 * namespace strings while dashboards and tier metadata speak in short logical
 * keys. One normalization function avoids split bars in “provider” charts.
 */
export function normalizeProviderKey(provider: string): string {
  return PROVIDER_KEY_MAP[provider] ?? provider;
}

/**
 * Stable key for aggregating usage rows that store the same logical model under
 * different id spellings (`xai/grok-4` vs `x-ai/grok-4`, `mistral/x` vs
 * `mistralai/x`). Suffix-only rows (no `/`) pass through unchanged.
 *
 * **Why OpenRouter form for prefixed ids:** We pick one canonical bucket for
 * charts and exports; OpenRouter ids match the merged catalog consumers see
 * today. **Why `__null__`:** Distinguishes “missing model” from an empty string
 * in SQL `GROUP BY` paths; UI maps it to `"unknown"`.
 */
export function canonicalUsageGroupingModel(model: string | null): string {
  if (!model) {
    return "__null__";
  }
  if (model.includes("/")) {
    return toOpenRouterModelId(model);
  }
  return model;
}

/**
 * `ai_pricing` rows written right after PR #482 may still use the raw OpenRouter
 * namespace in `provider` (`x-ai`, `mistralai`). Logical keys are `xai` /
 * `mistral`. Include both when resolving persisted rows.
 *
 * **Why an ordered tuple:** `ai-pricing` tie-break prefers the first entry so
 * logical keys win over transitional duplicates; order here must match that
 * preference.
 */
export function expandPersistedPricingProviderKeys(logicalProvider: string): readonly string[] {
  const p = normalizeProviderKey(logicalProvider);
  if (p === "xai") {
    return ["xai", "x-ai"];
  }
  if (p === "mistral") {
    return ["mistral", "mistralai"];
  }
  return [p];
}
