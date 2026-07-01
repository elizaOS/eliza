/**
 * Agent provisioning: migrations, agent/entity/room setup, embedding dimension.
 * Runs once at deploy/daemon boot; not part of runtime.initialize().
 * Export from node entry point only (not browser/edge).
 *
 * WHY this module exists:
 * - Keeps the runtime a lean request handler; heavy one-time setup lives here.
 * - Edge and ephemeral runtimes can skip provisioning entirely (they don't import this).
 * - Daemon entry points call provisionAgent() once after initialize().
 */

import { createLogger } from "./logger";
import type { Agent, Character, JsonValue, UUID } from "./types";
import { ChannelType } from "./types";
import type { IDatabaseAdapter } from "./types/database";
import type { IAgentRuntime } from "./types/runtime";

const logger = createLogger({ namespace: "provisioning", level: "info" });

export interface ProvisionAgentOptions {
	/** Run plugin schema migrations (DDL). Default true for daemon. */
	runMigrations?: boolean;
}

type AgentProvisioningRuntime = IAgentRuntime & {
	ensureAgentExists(agent: Partial<Agent>): Promise<Agent | null>;
};

function hasAgentProvisioningRuntime(
	runtime: IAgentRuntime,
): runtime is AgentProvisioningRuntime {
	return (
		"ensureAgentExists" in runtime &&
		typeof runtime.ensureAgentExists === "function"
	);
}

/**
 * Run plugin migrations (DDL) using the runtime's adapter and registered plugins.
 * WHY standalone: Migrations are a one-time basic-capabilities step; not part of initialize()
 * so ephemeral/edge runtimes never run them. process.env guards allow safe use in Node only.
 */
export async function runPluginMigrations(
	runtime: IAgentRuntime,
): Promise<void> {
	const adapter = runtime.adapter;
	if (!adapter) {
		logger.warn(
			{ src: "provisioning", agentId: runtime.agentId },
			"Database adapter not found, skipping plugin migrations",
		);
		return;
	}
	if (typeof adapter.runPluginMigrations !== "function") {
		logger.warn(
			{ src: "provisioning", agentId: runtime.agentId },
			"Database adapter does not support plugin migrations",
		);
		return;
	}

	const pluginsWithSchemas = runtime.plugins
		.filter((p) => p.schema)
		.map((p) => {
			const schema = p.schema || {};
			const normalizedSchema: Record<string, JsonValue> = {};
			for (const [key, value] of Object.entries(schema)) {
				if (
					typeof value === "string" ||
					typeof value === "number" ||
					typeof value === "boolean" ||
					value === null ||
					(typeof value === "object" && value !== null)
				) {
					normalizedSchema[key] = value as JsonValue;
				}
			}
			return { name: p.name, schema: normalizedSchema };
		});

	if (pluginsWithSchemas.length === 0) {
		logger.debug(
			{ src: "provisioning", agentId: runtime.agentId },
			"No plugins with schemas, skipping migrations",
		);
		return;
	}

	const isProduction =
		typeof process !== "undefined" && process.env.NODE_ENV === "production";
	const forceDestructive =
		typeof process !== "undefined" &&
		process.env.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

	await adapter.runPluginMigrations(pluginsWithSchemas, {
		verbose: !isProduction,
		force: forceDestructive,
		dryRun: false,
	});
	logger.debug(
		{ src: "provisioning", agentId: runtime.agentId },
		"Plugin migrations completed",
	);
}

/**
 * Ensure agent row exists, then entity, self-room, and self-participant.
 * Uses batch adapter APIs (getAgentsByIds, createEntities, getRoomsByIds, etc.).
 * WHY: Agent must exist before the runtime can store memories/tasks; self-room and
 * participant are required for core conversation flow.
 */
export async function ensureAgentInfrastructure(
	runtime: IAgentRuntime,
): Promise<void> {
	const adapter = runtime.adapter;
	const agentId = runtime.agentId;
	const character = runtime.character;

	if (!hasAgentProvisioningRuntime(runtime)) {
		throw new Error("Runtime does not support agent provisioning");
	}

	const existingAgent = await runtime.ensureAgentExists({
		...character,
		id: agentId,
	} as Partial<Agent>);
	if (!existingAgent) {
		throw new Error(
			`Agent ${agentId} does not exist in database after ensureAgentExists call`,
		);
	}

	const entities = await adapter.getEntitiesByIds([agentId]);
	let agentEntity = entities[0] ?? null;
	if (!agentEntity) {
		await adapter.createEntities([
			{
				id: agentId,
				names: [character.name ?? "Agent"],
				metadata: {},
				agentId: existingAgent.id ?? agentId,
			},
		]);
		const refetched = await adapter.getEntitiesByIds([agentId]);
		agentEntity = refetched[0] ?? null;
		if (!agentEntity) {
			throw new Error(`Agent entity not found for ${agentId}`);
		}
	}

	const rooms = await adapter.getRoomsByIds([agentId]);
	if (rooms.length === 0) {
		await adapter.createRooms([
			{
				id: agentId,
				name: character.name ?? "Agent",
				source: "elizaos",
				type: ChannelType.SELF,
				channelId: agentId,
				messageServerId: agentId,
				worldId: agentId,
			},
		]);
	}

	const participantResults = await adapter.getParticipantsForRooms([agentId]);
	const participants = participantResults[0]?.entityIds ?? [];
	if (!participants.includes(agentId)) {
		await adapter.createRoomParticipants([agentId], agentId);
	}
}

/**
 * Set embedding dimension on the adapter from config (no LLM call).
 * Reads EMBEDDING_DIMENSIONS (plural, what the runtime embedder uses) or
 * EMBEDDING_DIMENSION (singular); plural wins on conflict. Skips if neither set.
 * WHY no LLM: Avoids a model call at boot; set the dimension in character
 * settings when using this path. If unset, embedding search may fail until dimension is set.
 */
export async function ensureEmbeddingDimension(
	runtime: IAgentRuntime,
): Promise<void> {
	const adapter = runtime.adapter;
	const model = runtime.getModel(
		"TEXT_EMBEDDING" as import("./types/model").ModelTypeName,
	);
	if (!model) {
		logger.debug(
			{ src: "provisioning", agentId: runtime.agentId },
			"No TEXT_EMBEDDING model registered, skipping embedding dimension",
		);
		return;
	}

	// The DB vector-column dimension MUST match the runtime embedder's output
	// dimension. `EMBEDDING_DIMENSION` (singular) is the historical provisioning
	// setting; `EMBEDDING_DIMENSIONS` (plural) is what the runtime embedder
	// (@elizaos/plugin-embeddings, src/utils/config.ts) actually reads to size its
	// output vectors. They are easily confused, and when they silently diverge the
	// embedder writes N-dim vectors into an M-dim column — storage/search breaks
	// and "no facts available" results. Accept both spellings. On conflict, PLURAL
	// wins: the DB column must match the embedder's real output dimension, and the
	// embedder reads the plural key — so it is the source of truth. Warn loudly.
	const parseDim = (value: unknown): number =>
		typeof value === "number"
			? value
			: typeof value === "string"
				? parseInt(value, 10)
				: NaN;
	const singular = parseDim(runtime.getSetting("EMBEDDING_DIMENSION"));
	const plural = parseDim(runtime.getSetting("EMBEDDING_DIMENSIONS"));
	const singularValid = Number.isFinite(singular) && singular > 0;
	const pluralValid = Number.isFinite(plural) && plural > 0;
	if (singularValid && pluralValid && singular !== plural) {
		logger.warn(
			{ src: "provisioning", agentId: runtime.agentId, singular, plural },
			`EMBEDDING_DIMENSION (${singular}) and EMBEDDING_DIMENSIONS (${plural}) conflict — ` +
				`the DB vector column and the runtime embedder must agree, or memory storage/search will break. ` +
				`Using EMBEDDING_DIMENSIONS=${plural} (the runtime embedder reads the plural key); ` +
				`set both to the same value (e.g. 1536 for OpenAI text-embedding-3-small, 384 for gte-small).`,
		);
	}
	// Plural wins on conflict (embedder's actual output dimension); otherwise use
	// whichever single key is valid.
	const dimension = pluralValid ? plural : singular;
	if (!Number.isFinite(dimension) || dimension <= 0) {
		logger.debug(
			{ src: "provisioning", agentId: runtime.agentId },
			"EMBEDDING_DIMENSION / EMBEDDING_DIMENSIONS not set or invalid, skipping (set it in character settings to avoid LLM detection)",
		);
		return;
	}

	await adapter.ensureEmbeddingDimension(dimension);
	logger.debug(
		{ src: "provisioning", agentId: runtime.agentId, dimension },
		"Embedding dimension set",
	);
}

/**
 * Orchestrator: run migrations (optional), ensure agent/entity/room/participant, set embedding dimension.
 * Call after runtime.initialize() in daemon mode.
 * WHY separate from initialize(): Ephemeral and edge runtimes do not call this;
 * only long-lived daemons run it once at boot.
 */
export async function provisionAgent(
	runtime: IAgentRuntime,
	options: ProvisionAgentOptions = {},
): Promise<void> {
	const { runMigrations = true } = options;

	if (runMigrations) {
		await runPluginMigrations(runtime);
	}
	await ensureAgentInfrastructure(runtime);
	await ensureEmbeddingDimension(runtime);
}

/**
 * Read agent from DB and merge settings/secrets into the given character.
 * Returns a new Character; does not mutate the input.
 * If no agent exists in DB, returns the character unchanged.
 * Call before constructing the runtime so the runtime gets merged settings.
 * WHY before runtime: The runtime constructor does not touch the DB; the host
 * loads DB-backed config once and passes the merged character in.
 */
export async function mergeDbSettings(
	character: Character,
	adapter: IDatabaseAdapter,
	agentId: UUID,
): Promise<Character> {
	const agents = await adapter.getAgentsByIds([agentId]);
	const existingAgent = agents[0] ?? null;
	if (!existingAgent?.settings) {
		return character;
	}

	const mergedSettings = {
		...existingAgent.settings,
		...character.settings,
	};

	const dbSecrets =
		existingAgent.secrets && typeof existingAgent.secrets === "object"
			? existingAgent.secrets
			: {};
	const dbSettingsSecrets =
		existingAgent.settings.secrets &&
		typeof existingAgent.settings.secrets === "object"
			? existingAgent.settings.secrets
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
		settings: mergedSettings,
		secrets:
			Object.keys(mergedSecrets).length > 0
				? (mergedSettings.secrets as Record<string, string>)
				: character.secrets,
	};
}
