/**
 * Canonical two-knob model pair: `ELIZA_MODEL_SMALL` / `ELIZA_MODEL_LARGE`.
 *
 * Operators think in two knobs — a small/fast model and a large/capable model —
 * while the runtime juggles a forest of per-provider, per-tier env vars
 * (`OPENAI_*`, `GOOGLE_*`, `GROQ_*`, `CEREBRAS_*`, bare `*_MODEL` aliases…).
 * This resolver collapses that forest to the operator's mental model: set the
 * pair once (env or per-agent character settings) and every lane derives from it.
 *
 * ## Precedence (per lane)
 *
 * Lane-specific var (escape hatch) → **canonical pair** → bare alias → lane
 * default. The pair slots *below* every lane-specific var and *above* bare
 * aliases and hardcoded defaults, so pair-unset is behavior-identical to today.
 *
 * ## Why this fixes boot-seed masking (#16592)
 *
 * `applyProviderModelEnvDefaults()` seeds `GOOGLE_/GROQ_/CEREBRAS_*_MODEL` into
 * `process.env` once at boot (process-global). A per-agent character-settings
 * `ELIZA_MODEL_SMALL/LARGE` could not influence those seeded values because the
 * boot defaults overwrote the per-agent selection for any agent that did not
 * also set the specific provider key. Resolving the pair at *read time* from the
 * per-agent source (character settings / env) lets a character override the
 * boot-seeded lane default without mutating process-global configuration.
 */

/** The two canonical knob names. */
export const CANONICAL_MODEL_SMALL_KEY = "ELIZA_MODEL_SMALL";
export const CANONICAL_MODEL_LARGE_KEY = "ELIZA_MODEL_LARGE";

export type CanonicalModelTier = "small" | "large";

/** Per-tier canonical key. */
export function canonicalModelKey(tier: CanonicalModelTier): string {
	return tier === "small" ? CANONICAL_MODEL_SMALL_KEY : CANONICAL_MODEL_LARGE_KEY;
}

/**
 * Minimal structural shape of a runtime/character that can resolve a setting.
 * Kept local (rather than importing `IAgentRuntime`) so this helper stays
 * browser/edge-safe and free of the runtime type graph.
 */
export interface CanonicalModelSource {
	getSetting(key: string): string | boolean | number | null;
}

function normalizeModelValue(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const str = typeof value === "string" ? value : String(value);
	const trimmed = str.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the canonical model for a tier from a per-agent source.
 *
 * Reads `ELIZA_MODEL_SMALL` (tier `"small"`) or `ELIZA_MODEL_LARGE`
 * (tier `"large"`) via the supplied setting reader (typically an
 * `IAgentRuntime`, whose `getSetting` checks per-agent character settings
 * before env). Returns the trimmed model id or `undefined` when the pair is
 * not set for this agent.
 *
 * @param source - Per-agent setting reader (runtime). `null`/`undefined` yields
 *   `undefined` (the caller falls back to lane defaults).
 * @param tier - Which knob to read.
 */
export function readCanonicalModel(
	source: CanonicalModelSource | null | undefined,
	tier: CanonicalModelTier,
): string | undefined {
	const raw = source?.getSetting(canonicalModelKey(tier));
	return normalizeModelValue(raw);
}
