import type { Character } from "./types/agent.ts";

/**
 * Flatten character.settings, character.secrets, and env into a single Record<string, string>.
 * Used when calling adapter factories (Plugin.adapter(agentId, settings)).
 *
 * **Adapter bootstrap settings:** Adapter factories run *before* the database is connected. They
 * cannot read runtime settings from the DB. Only settings available from character config
 * and process.env (e.g. POSTGRES_URL, PGLITE_DATA_DIR, MONGODB_URI) are valid here. Runtime
 * settings loaded from the DB are supplied separately by the host.
 *
 * **Merge order:** env first, then character.settings (excluding nested secrets object),
 * then character.settings.secrets, then character.secrets. Later sources override earlier
 * (character overrides env). WHY: Allows env defaults while letting character config override.
 *
 * @param character - Character to read settings and secrets from
 * @param env - Environment record (defaults to process.env)
 * @returns String-only record suitable for adapter factories
 */
/**
 * Encode one setting value as a string for the flat adapter record.
 * Strings pass through; objects and arrays are JSON-encoded so their
 * content survives instead of collapsing to "[object Object]" (objects)
 * or a comma join (arrays). `JSON.stringify` can return `undefined` for
 * values with no JSON form, which falls back to `String(value)`.
 */
function stringifySettingValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	if (value !== null && typeof value === "object") {
		return JSON.stringify(value) ?? String(value);
	}
	return String(value);
}

export function flattenRuntimeSettings(
	character: Character,
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};

	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined && value !== null && key) {
			out[key] = String(value);
		}
	}

	const settings =
		character.settings && typeof character.settings === "object"
			? character.settings
			: {};
	for (const [key, value] of Object.entries(settings)) {
		if (value === undefined || value === null) continue;
		if (key === "secrets" && typeof value === "object") continue;
		out[key] = stringifySettingValue(value);
	}

	const secrets = (
		character.settings?.secrets &&
		typeof character.settings.secrets === "object"
			? character.settings.secrets
			: {}
	) as Record<string, unknown>;
	for (const [key, value] of Object.entries(secrets)) {
		if (value !== undefined && value !== null) {
			out[key] = stringifySettingValue(value);
		}
	}

	const topSecrets =
		character.secrets && typeof character.secrets === "object"
			? character.secrets
			: {};
	for (const [key, value] of Object.entries(topSecrets)) {
		if (value !== undefined && value !== null) {
			out[key] = stringifySettingValue(value);
		}
	}

	return out;
}
