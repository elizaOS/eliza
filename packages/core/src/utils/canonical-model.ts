/**
 * Canonical two-knob model selection: `ELIZA_MODEL_SMALL` / `ELIZA_MODEL_LARGE`.
 *
 * The deployment sets at most two model names; code decides which tier uses
 * small or large. Every model-provider lane consults this pair at the position
 * its bare alias (`SMALL_MODEL`/`LARGE_MODEL`) sits today — BELOW the lane's
 * provider-prefixed escape hatches (`OPENAI_SMALL_MODEL`, `ELIZA_CLI_CLAUDE_MODEL`,
 * …) and ABOVE its hardcoded default — so existing configs are untouched and
 * the pair only speaks when nothing more specific does.
 *
 * Values may be provider-qualified (`anthropic/claude-sonnet-5`, matching the
 * `agents.defaults.model.primary` convention). A lane passes its family and a
 * qualified value is honored only when the family matches — an unqualified
 * value is honored by every lane, which is the single-provider deployment case.
 * This is what keeps `ELIZA_MODEL_LARGE=claude-opus-4-8` from being sent to an
 * OpenAI-family endpoint as a literal model id (live 404).
 *
 * Blank strings are unset: several lanes chain with `??`, where a persisted
 * `""` silently masks every later leg.
 */

import { resolveSetting, type SettingReader } from "./resolve-setting.js";

export type CanonicalModelTier = "small" | "large";

/** Every token that counts as a family qualification prefix. */
const KNOWN_FAMILY_TOKENS: ReadonlySet<string> = new Set(
	Object.values({
		openai: ["openai", "gpt"],
		anthropic: ["anthropic", "claude"],
		ollama: ["ollama"],
		google: ["google", "google-genai", "gemini"],
		elizacloud: ["elizacloud", "eliza-cloud", "cloud"],
		cerebras: ["cerebras"],
		groq: ["groq"],
		codex: ["codex"],
	}).flat(),
);

/**
 * Whether the raw canonical value for a tier is family-qualified (its first
 * "/" segment is a known family token). Seed-time guards use this to decide
 * whether a heuristic id-shape check still applies: a qualified value was
 * explicitly targeted by the operator; an unqualified one was not.
 */
export function canonicalModelIsQualified(
	runtime: SettingReader | null | undefined,
	tier: CanonicalModelTier,
): boolean {
	const raw = resolveSetting(runtime, CANONICAL_MODEL_ENV_KEYS[tier])?.trim();
	if (!raw) return false;
	const slash = raw.indexOf("/");
	if (slash <= 0) return false;
	return KNOWN_FAMILY_TOKENS.has(raw.slice(0, slash).trim().toLowerCase());
}

export const CANONICAL_MODEL_ENV_KEYS: Readonly<
	Record<CanonicalModelTier, string>
> = {
	small: "ELIZA_MODEL_SMALL",
	large: "ELIZA_MODEL_LARGE",
};

/**
 * Family aliases a qualified canonical value may name. Keys are the family ids
 * lanes pass; values are the prefixes accepted for that lane (lowercased).
 * `claude`/`codex` are the CLI-inference backends — subscription lanes whose
 * upstream family differs from the transport name users type.
 */
const FAMILY_ALIASES: Readonly<Record<string, readonly string[]>> = {
	openai: ["openai", "gpt"],
	anthropic: ["anthropic", "claude"],
	ollama: ["ollama"],
	google: ["google", "google-genai", "gemini"],
	elizacloud: ["elizacloud", "eliza-cloud", "cloud"],
	cerebras: ["cerebras"],
	groq: ["groq"],
	claude: ["claude", "anthropic"],
	codex: ["codex", "openai", "gpt"],
};

/**
 * Read the canonical model for a tier, family-gated.
 *
 * @param runtime - Setting reader (per-agent settings win; env is the
 *   deployment fallback via {@link resolveSetting} semantics)
 * @param tier - Which of the pair to read
 * @param family - The consulting lane's family id (see {@link FAMILY_ALIASES}).
 *   When omitted, only unqualified values are returned (a qualified value
 *   cannot be safety-checked without a family).
 * @returns The bare model id, or undefined when unset, blank, or qualified for
 *   a different family
 */
export function readCanonicalModel(
	runtime: SettingReader | null | undefined,
	tier: CanonicalModelTier,
	family?: string,
): string | undefined {
	const raw = resolveSetting(runtime, CANONICAL_MODEL_ENV_KEYS[tier]);
	const value = raw?.trim();
	if (!value) return undefined;

	const slash = value.indexOf("/");
	if (slash <= 0) return value;

	const prefix = value.slice(0, slash).trim().toLowerCase();
	// Native model ids legitimately contain "/" (meta-llama/llama-4-*, ollama's
	// hf.co/...). Only a KNOWN family token in the first segment is a
	// qualification; anything else is part of the id. When a native id's first
	// segment COLLIDES with a family token (groq's native openai/gpt-oss-120b),
	// the token wins: the value parses as an `openai` qualification and is
	// never treated as the slash-bearing groq id. The supported spelling for
	// such ids is the explicit family-pinned form — groq/openai/gpt-oss-120b —
	// which strips to the full native id for the pinned family and is rejected
	// everywhere else (pinned by test).
	if (!KNOWN_FAMILY_TOKENS.has(prefix)) return value;

	// A qualified value names its family; without a family to check against it
	// must NOT leak the bare id to arbitrary consumers (a family-agnostic
	// caller would otherwise feed e.g. a claude id into a groq seed).
	if (!family) return undefined;

	const model = value.slice(slash + 1).trim();
	if (!model) return undefined;

	const aliases = FAMILY_ALIASES[family.toLowerCase()] ?? [
		family.toLowerCase(),
	];
	return aliases.includes(prefix) ? model : undefined;
}
