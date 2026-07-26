/**
 * Resolves the deployment-wide small/large model pair while preventing a
 * provider-qualified model id from crossing model families.
 *
 * Per-agent settings outrank environment defaults. Blank runtime values are
 * unset, while malformed or mistyped runtime values fail closed so an
 * explicit per-agent value cannot silently expose a host-level fallback.
 * Provider adapters own the surrounding precedence against their specific
 * escape hatches, bare aliases, and defaults.
 */

import { type ReadEnvOptions, readEnv } from "./read-env.js";
import type { SettingReader } from "./resolve-setting.js";

export const CANONICAL_MODEL_ENV_KEYS = {
	small: "ELIZA_MODEL_SMALL",
	large: "ELIZA_MODEL_LARGE",
} as const;

export type CanonicalModelTier = keyof typeof CANONICAL_MODEL_ENV_KEYS;

const FAMILY_ALIASES = {
	openai: ["openai", "gpt"],
	anthropic: ["anthropic", "claude"],
	ollama: ["ollama"],
	google: ["google", "google-genai", "gemini"],
	elizacloud: ["elizacloud", "eliza-cloud", "cloud"],
	cerebras: ["cerebras"],
	groq: ["groq"],
	claude: ["claude", "anthropic"],
	codex: ["codex", "openai", "gpt"],
} as const satisfies Record<string, readonly string[]>;

export type CanonicalModelFamily = keyof typeof FAMILY_ALIASES;

export type CanonicalModelReadOptions = Pick<ReadEnvOptions, "env">;

const KNOWN_FAMILY_TOKENS: ReadonlySet<string> = new Set(
	Object.values(FAMILY_ALIASES).flat(),
);

type ConfiguredCanonicalModel =
	| { state: "missing" }
	| { state: "invalid" }
	| { state: "value"; value: string };

type ParsedCanonicalModel =
	| { kind: "unqualified"; model: string }
	| { kind: "qualified"; familyToken: string; model: string };

function isCanonicalModelFamily(value: string): value is CanonicalModelFamily {
	return Object.hasOwn(FAMILY_ALIASES, value);
}

function readConfiguredCanonicalModel(
	runtime: SettingReader | null | undefined,
	tier: CanonicalModelTier,
	options: CanonicalModelReadOptions,
): ConfiguredCanonicalModel {
	const key = CANONICAL_MODEL_ENV_KEYS[tier];
	const runtimeValue = runtime?.getSetting(key);
	if (runtimeValue !== undefined && runtimeValue !== null) {
		if (typeof runtimeValue !== "string") {
			return { state: "invalid" };
		}
		const normalizedRuntimeValue = runtimeValue.trim();
		if (normalizedRuntimeValue) {
			return { state: "value", value: normalizedRuntimeValue };
		}
	}

	const envValue = readEnv(key, { env: options.env });
	return envValue ? { state: "value", value: envValue } : { state: "missing" };
}

function parseCanonicalModel(value: string): ParsedCanonicalModel | undefined {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
			return undefined;
		}
	}

	const slash = value.indexOf("/");
	if (slash < 0) {
		return { kind: "unqualified", model: value };
	}
	if (slash === 0) {
		return undefined;
	}

	const familyToken = value.slice(0, slash).trim().toLowerCase();
	if (!KNOWN_FAMILY_TOKENS.has(familyToken)) {
		return { kind: "unqualified", model: value };
	}

	const model = value.slice(slash + 1).trim();
	if (!model || model.startsWith("/")) {
		return undefined;
	}
	return { kind: "qualified", familyToken, model };
}

/**
 * Reports whether the selected pair value carries a recognized family
 * qualifier. Native slash-bearing ids whose first segment is not a recognized
 * family remain unqualified.
 */
export function canonicalModelIsQualified(
	runtime: SettingReader | null | undefined,
	tier: CanonicalModelTier,
	options: CanonicalModelReadOptions = {},
): boolean {
	const configured = readConfiguredCanonicalModel(runtime, tier, options);
	if (configured.state !== "value") {
		return false;
	}
	return parseCanonicalModel(configured.value)?.kind === "qualified";
}

/**
 * Reads one canonical model tier and applies its family gate.
 *
 * Qualified values return only to their matching provider or transport
 * family. Omitting `family` accepts only unqualified values, which is useful
 * for host code that cannot prove which provider will consume the result.
 */
export function readCanonicalModel(
	runtime: SettingReader | null | undefined,
	tier: CanonicalModelTier,
	family?: CanonicalModelFamily,
	options: CanonicalModelReadOptions = {},
): string | undefined {
	const configured = readConfiguredCanonicalModel(runtime, tier, options);
	if (configured.state !== "value") {
		return undefined;
	}

	const parsed = parseCanonicalModel(configured.value);
	if (!parsed) {
		return undefined;
	}
	if (family !== undefined && !isCanonicalModelFamily(family)) {
		return undefined;
	}
	if (parsed.kind === "unqualified") {
		return parsed.model;
	}
	if (!family) {
		return undefined;
	}

	const aliases: readonly string[] = FAMILY_ALIASES[family];
	return aliases.includes(parsed.familyToken) ? parsed.model : undefined;
}
