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
		typeof process !== "undefined" && process.env?.NODE_ENV === "production";
	const forceDestructive =
		typeof process !== "undefined" &&
		process.env?.ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS === "true";

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
 * Uses EMBEDDING_DIMENSION setting if set; otherwise skips.
 * WHY no LLM: Avoids a model call at boot; set EMBEDDING_DIMENSION in character
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

	const raw = runtime.getSetting("EMBEDDING_DIMENSION");
	const dimension =
		typeof raw === "number"
			? raw
			: typeof raw === "string"
				? parseInt(raw, 10)
				: NaN;
	if (!Number.isFinite(dimension) || dimension <= 0) {
		logger.debug(
			{ src: "provisioning", agentId: runtime.agentId },
			"EMBEDDING_DIMENSION not set or invalid, skipping (set it in character settings to avoid LLM detection)",
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
