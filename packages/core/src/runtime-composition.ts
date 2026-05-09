/**
 * Runtime composition: building blocks for creating elizaOS runtimes.
 *
 * This module provides a small, composable API so hosts (daemon, cloud, serverless,
 * eliza, etc.) can set up runtimes without duplicating adapter creation, plugin
 * resolution, or settings merge logic.
 *
 * **WHY a composition layer:** Different hosts need different flows (e.g. cloud may
 * use its own adapter pool and skip createRuntimes), but they share the need to
 * load characters, resolve plugins, create adapters before the runtime, and merge
 * DB-backed settings. This module composes existing helpers so each host can use
 * the pieces it needs.
 *
 * **Exports:**
 * - loadCharacters(sources, options?) – JSON file paths (strings) and/or inline CharacterInput; optional `cwd` for relative paths.
 * - getBasicCapabilitiesSettings(character) – flatten character + env for adapter factories (basic-capabilities only).
 * - mergeSettingsInto(character, agentRecord) – pure merge of DB agent into character (for custom pipelines).
 * - createRuntimes(characters, options?) – full pipeline; options carry adapter override, provision, logLevel, etc.
 *
 * **Settings divide:** Adapter factories receive only *basic-capabilities* settings (character + env).
 * Runtime settings from the DB are merged *after* the adapter is created and used when
 * constructing the runtime. WHY: You cannot load settings from the DB until the adapter
 * is connected; basic-capabilities settings (e.g. POSTGRES_URL, PGLITE_DATA_DIR) are what you
 * need to create the adapter in the first place.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { CharacterInput } from "./character";
import { parseCharacter } from "./character";
import { COMMON_SECRET_KEYS, importSecretsFromEnv } from "./character-utils";
import { resolvePlugins } from "./plugin";
import {
	ensureAgentInfrastructure,
	ensureEmbeddingDimension,
	runPluginMigrations,
} from "./provisioning";
import { AgentRuntime } from "./runtime";
import type { Character, IAgentRuntime, IDatabaseAdapter } from "./types";
import type { AdapterFactory, Plugin } from "./types/plugin";
import type { UUID } from "./types/primitives";
import { stringToUuid } from "./utils";

type PluginWithAdapter = Plugin & {
	adapter: AdapterFactory;
};

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
export function getBasicCapabilitiesSettings(
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

/**
 * Minimal shape of an agent record as returned from the database (e.g. getAgentsByIds).
 * Used by mergeSettingsInto so callers can pass either a full Agent or a subset with
 * settings/secrets. WHY loose type: Custom hosts (e.g. cloud) may have their own
 * agent-like structures; this keeps the merge logic reusable.
 */
export interface AgentRecordForMerge {
	settings?: Record<string, unknown>;
	secrets?: Record<string, unknown>;
}

/**
 * Merge DB-backed agent settings and secrets into a character (pure, no DB call).
 * Same merge order as mergeDbSettings in provisioning.ts: DB base, character overrides.
 *
 * **WHY exported:** Custom hosts (e.g. cloud with its own adapter pool and caching) may
 * load agent records themselves and need to apply the same merge semantics without
 * calling mergeDbSettings (which takes an adapter and does the DB fetch). This function
 * is the pure merge step only.
 *
 * @param character - Character to merge into (not mutated)
 * @param agentRecord - Agent record from DB (e.g. getAgentsByIds result item), or null
 * @returns New character with merged settings and secrets
 */
export function mergeSettingsInto(
	character: Character,
	agentRecord: AgentRecordForMerge | null,
): Character {
	if (!agentRecord?.settings) {
		return character;
	}

	const mergedSettings = {
		...agentRecord.settings,
		...character.settings,
	};

	const dbSecrets =
		agentRecord.secrets && typeof agentRecord.secrets === "object"
			? agentRecord.secrets
			: {};
	const dbSettingsSecrets =
		agentRecord.settings.secrets &&
		typeof agentRecord.settings.secrets === "object"
			? (agentRecord.settings.secrets as Record<string, unknown>)
			: {};
	const characterSecrets =
		character.secrets && typeof character.secrets === "object"
			? character.secrets
			: {};
	const characterSettingsSecrets =
		character.settings?.secrets &&
		typeof character.settings.secrets === "object"
			? character.settings.secrets
			: {};
	const mergedSecrets = {
		...dbSecrets,
		...dbSettingsSecrets,
		...characterSecrets,
		...characterSettingsSecrets,
	};

	if (Object.keys(mergedSecrets).length > 0) {
		const filtered: Record<string, string> = {};
		for (const [key, value] of Object.entries(mergedSecrets)) {
			if (value !== null && value !== undefined) {
				filtered[key] = String(value);
			}
		}
		if (Object.keys(filtered).length > 0) {
			mergedSettings.secrets = filtered;
		}
	}

	return {
		...character,
		settings: mergedSettings as Character["settings"],
		secrets:
			Object.keys(mergedSecrets).length > 0
				? (mergedSettings.secrets as Record<string, string>)
				: character.secrets,
	};
}

/**
 * Load one character from an inline object. Uses parseCharacter (validation + normalize).
 */
function loadOneCharacterFromObject(input: CharacterInput): Character {
	const character = parseCharacter(input);
	let out = importSecretsFromEnv(character, COMMON_SECRET_KEYS);

	if (!out.id) {
		out = { ...out, id: stringToUuid(out.name ?? "eliza") as UUID };
	}
	return out;
}

/** Options for {@link loadCharacters}. */
export interface LoadCharactersOptions {
	/**
	 * Base directory for resolving relative file paths in `sources`.
	 * Defaults to `process.cwd()`.
	 */
	cwd?: string;
}

/**
 * Load characters from file paths and/or inline character objects.
 * String entries are UTF-8 JSON files (`.json`). Uses `parseCharacter` and `importSecretsFromEnv`.
 *
 * **WHY accept mixed sources:** Daemons often load from files; programmatic hosts (e.g. cloud,
 * serverless) may build character config in code. One API supports both.
 *
 * @param sources - Relative or absolute JSON file paths, or CharacterInput objects
 * @param options - Optional `cwd` for relative paths
 * @returns Validated Character[] (empty array if sources is empty)
 * @throws If a file path fails to load or an object fails validation (message includes path/details)
 */
export async function loadCharacters(
	sources: Array<CharacterInput | string>,
	options?: LoadCharactersOptions,
): Promise<Character[]> {
	if (sources.length === 0) {
		return [];
	}

	const baseCwd = options?.cwd ?? process.cwd();
	const results: Character[] = [];

	for (const source of sources) {
		if (typeof source === "string") {
			const resolved = path.isAbsolute(source)
				? source
				: path.resolve(baseCwd, source);
			if (!existsSync(resolved)) {
				throw new Error(
					`loadCharacters: character file not found: ${resolved}`,
				);
			}
			try {
				const raw = await readFile(resolved, "utf8");
				const json = JSON.parse(raw) as CharacterInput;
				results.push(loadOneCharacterFromObject(json));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`loadCharacters: failed to load ${resolved}: ${message}`,
				);
			}
		} else {
			results.push(loadOneCharacterFromObject(source));
		}
	}

	return results;
}

/** Options for {@link createRuntimes} (second argument). */
export interface CreateRuntimesOptions {
	/** Override: use this adapter for all characters (skip adapter discovery). WHY: Cloud/custom hosts may manage their own adapter pool. */
	adapter?: IDatabaseAdapter;
	/** Extra plugins to include for all characters (merged with character.plugins). WHY: Hosts like eliza add their own plugin without putting it in every character file. */
	sharedPlugins?: Plugin[];
	/** Run provisioning after init: migrations once per unique adapter, then ensureAgentInfrastructure + ensureEmbeddingDimension per runtime. Default false. WHY: Daemons need it once at boot; serverless/ephemeral usually skip. */
	provision?: boolean;
	/** Log level for created runtimes. */
	logLevel?: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
	/** Extra settings applied to each runtime (e.g. MODEL_PROVIDER override). */
	settings?: Record<string, string | boolean | number>;
	/** When false, the runtime always responds (e.g. direct chat / harness). Passed to AgentRuntime. */
	checkShouldRespond?: boolean;
}

/**
 * Create runtimes from characters: resolve plugins once (batch), create adapters from
 * plugin adapter factory, init adapters (deduped), batch merge DB settings per unique
 * adapter, create AgentRuntime instances, initialize them, optionally provision.
 *
 * **WHY batch where possible:** Resolving plugins once for all characters avoids duplicate
 * work and keeps dependency order consistent. getAgentsByIds is called once per unique
 * adapter with all agent IDs for that adapter (not once per character). WHY: Fewer DB
 * round-trips when multiple characters share the same DB.
 *
 * **Adapter discovery:** The first resolved plugin that defines an adapter factory
 * (Plugin.adapter) is used. If options.adapter is set, that overrides and is used for
 * all characters. WHY: One adapter per character is the common case; shared override
 * supports custom pooling. Plugins that only attach the DB in `init` (some `@elizaos/plugin-sql`
 * builds) expose no `adapter` factory — pass `options.adapter` from `createDatabaseAdapter`
 * (or equivalent) instead.
 *
 * @param characters - Validated characters (e.g. from loadCharacters)
 * @param options - Optional adapter override, sharedPlugins, provision, logLevel, settings
 * @returns Initialized IAgentRuntime[] (empty if characters is empty)
 */
export async function createRuntimes(
	characters: Character[],
	options?: CreateRuntimesOptions,
): Promise<IAgentRuntime[]> {
	if (characters.length === 0) {
		return [];
	}

	const pluginNames = new Set<string>();
	for (const c of characters) {
		for (const p of c.plugins ?? []) {
			if (typeof p === "string") pluginNames.add(p);
		}
	}
	const pluginInput: (string | Plugin)[] = [...pluginNames];
	if (options?.sharedPlugins?.length) {
		pluginInput.push(...options.sharedPlugins);
	}
	const resolvedPlugins = await resolvePlugins(pluginInput);

	const agentIds: UUID[] = [];
	for (const c of characters) {
		agentIds.push((c.id ?? stringToUuid(c.name ?? "eliza")) as UUID);
	}

	let adapters: IDatabaseAdapter[];
	if (options?.adapter) {
		const defaultAdapter = options.adapter;
		adapters = characters.map(() => defaultAdapter);
	} else {
		const adapterPlugin = resolvedPlugins.find(
			(p): p is PluginWithAdapter => typeof p.adapter === "function",
		);
		if (!adapterPlugin) {
			const first = characters[0];
			const nameOrId = first?.name ?? first?.id ?? "unknown";
			throw new Error(
				`No plugin provides a database adapter for character ${String(nameOrId)}`,
			);
		}
		adapters = await Promise.all(
			characters.map((c) => {
				const agentId = (c.id ?? stringToUuid(c.name ?? "eliza")) as UUID;
				const settings = getBasicCapabilitiesSettings(c);
				return Promise.resolve(adapterPlugin.adapter(agentId, settings));
			}),
		);
	}

	// WHY dedupe by adapter reference: Multiple characters can share the same adapter
	// (e.g. same POSTGRES_URL). initialize() must be called only once per underlying
	// connection to avoid duplicate setup or errors.
	const seenAdapters = new Set<IDatabaseAdapter>();
	for (const adapter of adapters) {
		if (seenAdapters.has(adapter)) continue;
		seenAdapters.add(adapter);
		if (!(await adapter.isReady())) {
			await adapter.initialize();
		}
	}

	// Group characters by adapter so we can call getAgentsByIds once per unique adapter
	// with all agent IDs for that adapter. WHY: Batch DB read instead of N reads for N characters.
	const adapterToAgentIds = new Map<IDatabaseAdapter, UUID[]>();
	for (let i = 0; i < characters.length; i++) {
		const adapter = adapters[i];
		const agentId = agentIds[i];
		if (!adapter || !agentId) {
			throw new Error(`Missing adapter or agentId for character index ${i}`);
		}
		const list = adapterToAgentIds.get(adapter) ?? [];
		list.push(agentId);
		adapterToAgentIds.set(adapter, list);
	}

	// Map agentId -> DB record. WHY key by agent.id: getAgentsByIds return order is not
	// guaranteed to match input ids order (e.g. SQL ORDER may differ); matching by id is safe.
	const agentIdToRecord = new Map<UUID, AgentRecordForMerge>();
	for (const [adapter, ids] of adapterToAgentIds) {
		const agents = await adapter.getAgentsByIds(ids);
		for (const agent of agents) {
			if (agent?.id)
				agentIdToRecord.set(agent.id as UUID, agent as AgentRecordForMerge);
		}
	}

	const mergedCharacters = characters.map((c, i) => {
		const agentId = agentIds[i];
		if (!agentId) {
			throw new Error(`Missing agentId for character index ${i}`);
		}
		const record = agentIdToRecord.get(agentId) ?? null;
		return mergeSettingsInto(c, record);
	});

	const runtimes = mergedCharacters.map((char, i) => {
		const adapter = adapters[i];
		if (!adapter) {
			throw new Error(`Missing adapter for character index ${i}`);
		}
		return new AgentRuntime({
			character: char,
			adapter,
			plugins: resolvedPlugins,
			logLevel: options?.logLevel,
			settings: options?.settings,
			checkShouldRespond: options?.checkShouldRespond,
		});
	});

	await Promise.all(runtimes.map((r) => r.initialize()));

	// WHY migrations once per unique adapter: Multiple runtimes can share one adapter.
	// Running migrations per runtime would repeat DDL; running once per adapter is correct.
	if (options?.provision) {
		const seenAdaptersForMigrations = new Set<IDatabaseAdapter>();
			for (const r of runtimes) {
				const adapter = r.adapter;
				if (adapter && !seenAdaptersForMigrations.has(adapter)) {
					seenAdaptersForMigrations.add(adapter);
					await runPluginMigrations(r);
				}
			}
			for (const r of runtimes) {
				await ensureAgentInfrastructure(r);
				await ensureEmbeddingDimension(r);
			}
		}

		return runtimes;
	}
