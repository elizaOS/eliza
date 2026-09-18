import type { Character } from "./types/agent.ts";

/**
 * Flatten character.settings, character.secrets, and env into a single Record<string, string>.
 * Used when calling adapter factories (Plugin.adapter(agentId, settings)).
 *
 * **WHY basic-capabilities-only:** Adapter factories run *before* the database is connected. They
 * cannot read runtime settings from the DB. Only settings available from character config
 * and process.env (e.g. POSTGRES_URL, PGLITE_DATA_DIR, MONGODB_URI) are valid here. Runtime
 * settings (API keys, model prefs, etc.) are merged later from the DB via mergeSettingsInto.
 *
 * **Merge order:** env first, then character.settings (excluding nested secrets object),
 * then character.settings.secrets, then character.secrets. Later sources override earlier
 * (character overrides env). WHY: Allows env defaults while letting character config override.
 *
 * @param character - Character to read settings and secrets from
 * @param env - Environment record (defaults to process.env)
 * @returns String-only record suitable for adapter factories
 */
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
		out[key] = typeof value === "string" ? value : String(value);
	}

	const secrets = (
		character.settings?.secrets &&
		typeof character.settings.secrets === "object"
			? character.settings.secrets
			: {}
	) as Record<string, unknown>;
	for (const [key, value] of Object.entries(secrets)) {
		if (value !== undefined && value !== null) {
			out[key] = String(value);
		}
	}

	const topSecrets =
		character.secrets && typeof character.secrets === "object"
			? character.secrets
			: {};
	for (const [key, value] of Object.entries(topSecrets)) {
		if (value !== undefined && value !== null) {
			out[key] = String(value);
		}
	}

	return out;
}
