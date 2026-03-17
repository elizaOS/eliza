/**
 * Abstract database schemas — the canonical data model for elizaOS.
 *
 * These SchemaTable objects define the structure of all core tables in a
 * database-agnostic format. Use buildBaseTables(adapter) to convert them
 * into concrete Drizzle table objects for a specific dialect.
 *
 * This module also exports advanced memory schemas (longTermMemories,
 * sessionSummaries, memoryAccessLogs) which are part of the enhanced
 * memory subsystem.
 */

// Import advanced memory schemas
import {
	longTermMemories,
	memoryAccessLogs,
	sessionSummaries,
} from "../advanced-memory/schemas/index.ts";
import type { BuildTableFn, DialectAdapter } from "../types/schema-builder.ts";
import { agentSchema } from "./agent.ts";
import { cacheSchema } from "./cache.ts";
import { channelSchema } from "./channel.ts";
import { channelParticipantSchema } from "./channel-participant.ts";
import { componentSchema } from "./component.ts";
import { embeddingSchema } from "./embedding.ts";
import { entitySchema } from "./entity.ts";
import { logSchema } from "./log.ts";
import { memorySchema } from "./memory.ts";
import { messageSchema } from "./message.ts";
import { messageServerSchema } from "./message-server.ts";
import { messageServerAgentSchema } from "./message-server-agent.ts";
import { pairingAllowlistSchema } from "./pairing-allowlist.ts";
import { pairingRequestSchema } from "./pairing-request.ts";
import { participantSchema } from "./participant.ts";
import { relationshipSchema } from "./relationship.ts";
import { roomSchema } from "./room.ts";
import { serverSchema } from "./server.ts";
import { taskSchema } from "./task.ts";
import { worldSchema } from "./world.ts";

// Export all abstract schemas
export {
	agentSchema,
	cacheSchema,
	channelSchema,
	channelParticipantSchema,
	componentSchema,
	embeddingSchema,
	entitySchema,
	logSchema,
	memorySchema,
	messageSchema,
	messageServerSchema,
	messageServerAgentSchema,
	pairingAllowlistSchema,
	pairingRequestSchema,
	participantSchema,
	relationshipSchema,
	roomSchema,
	serverSchema,
	taskSchema,
	worldSchema,
	// Advanced memory schemas
	longTermMemories,
	memoryAccessLogs,
	sessionSummaries,
};

/**
 * Type for the object returned by buildBaseTables().
 * Represents all 20 core database tables as ORM table objects.
 */
export interface BaseTables {
	agent: any;
	cache: any;
	channel: any;
	channelParticipant: any;
	component: any;
	embedding: any;
	entity: any;
	log: any;
	memory: any;
	message: any;
	messageServer: any;
	messageServerAgent: any;
	pairingAllowlist: any;
	pairingRequest: any;
	participant: any;
	relationship: any;
	room: any;
	server: any;
	task: any;
	world: any;
}

/**
 * Factory: build all 20 base tables using the given dialect adapter and buildTable function.
 *
 * This is the single source of truth for the elizaOS data model. Plugins
 * import this function and pass their dialect adapter (pgAdapter, mysqlAdapter)
 * to get concrete ORM table objects.
 *
 * The buildTable function is provided by the plugin (e.g., from plugin-sql).
 *
 * @param buildTable - The buildTable function from the plugin
 * @param adapter - The dialect-specific adapter (pgAdapter or mysqlAdapter).
 * @returns An object with all 20 tables, keyed by camelCase name.
 */
export function buildBaseTables(
	buildTable: BuildTableFn,
	adapter: DialectAdapter,
): BaseTables {
	return {
		agent: buildTable(agentSchema, adapter),
		cache: buildTable(cacheSchema, adapter),
		channel: buildTable(channelSchema, adapter),
		channelParticipant: buildTable(channelParticipantSchema, adapter),
		component: buildTable(componentSchema, adapter),
		embedding: buildTable(embeddingSchema, adapter),
		entity: buildTable(entitySchema, adapter),
		log: buildTable(logSchema, adapter),
		memory: buildTable(memorySchema, adapter),
		message: buildTable(messageSchema, adapter),
		messageServer: buildTable(messageServerSchema, adapter),
		messageServerAgent: buildTable(messageServerAgentSchema, adapter),
		pairingAllowlist: buildTable(pairingAllowlistSchema, adapter),
		pairingRequest: buildTable(pairingRequestSchema, adapter),
		participant: buildTable(participantSchema, adapter),
		relationship: buildTable(relationshipSchema, adapter),
		room: buildTable(roomSchema, adapter),
		server: buildTable(serverSchema, adapter),
		task: buildTable(taskSchema, adapter),
		world: buildTable(worldSchema, adapter),
	};
}
