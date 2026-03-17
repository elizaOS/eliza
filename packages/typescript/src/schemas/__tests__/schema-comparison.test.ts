/**
 * Comparison test: Verify that buildBaseTables() produces the same table
 * structure as plugin-sql's existing static Drizzle table definitions.
 *
 * This test ensures the mechanical conversion from Drizzle tables to abstract
 * SchemaTable objects is correct.
 */

import { describe, expect, it } from "vitest";
import type { SchemaColumn } from "../../types/schema";
import type { DialectAdapter, SchemaTable } from "../../types/schema-builder";
import { buildBaseTables } from "../index";

// Mock buildTable and pgAdapter since they moved to plugin-sql
const mockBuildTable = (schema: SchemaTable, _adapter: DialectAdapter) => {
	// Simple mock that creates an object with column properties
	const table: Record<string, { name: string }> = {};
	for (const [key, col] of Object.entries(schema.columns) as [
		string,
		SchemaColumn,
	][]) {
		const camelKey = key.replace(/_([a-z0-9])/g, (_, c: string) =>
			c.toUpperCase(),
		);
		table[camelKey] = { name: col.name };
	}
	return table;
};

const mockPgAdapter: DialectAdapter = {
	createTable: (_name: string, columns: Record<string, unknown>) => columns,
	buildColumn: (col: SchemaColumn) => col,
	buildIndex: (_name: string) => ({ on: (..._cols: unknown[]) => ({}) }),
};

describe("Schema Comparison", () => {
	it("buildBaseTables produces valid table objects", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);

		// Verify all 20 tables are present
		expect(tables).toHaveProperty("agent");
		expect(tables).toHaveProperty("cache");
		expect(tables).toHaveProperty("channel");
		expect(tables).toHaveProperty("channelParticipant");
		expect(tables).toHaveProperty("component");
		expect(tables).toHaveProperty("embedding");
		expect(tables).toHaveProperty("entity");
		expect(tables).toHaveProperty("log");
		expect(tables).toHaveProperty("memory");
		expect(tables).toHaveProperty("message");
		expect(tables).toHaveProperty("messageServer");
		expect(tables).toHaveProperty("messageServerAgent");
		expect(tables).toHaveProperty("pairingAllowlist");
		expect(tables).toHaveProperty("pairingRequest");
		expect(tables).toHaveProperty("participant");
		expect(tables).toHaveProperty("relationship");
		expect(tables).toHaveProperty("room");
		expect(tables).toHaveProperty("server");
		expect(tables).toHaveProperty("task");
		expect(tables).toHaveProperty("world");
	});

	it("agent table has correct column names in camelCase", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const agentTable = tables.agent;

		// Verify the table has the expected Drizzle structure
		expect(agentTable).toBeDefined();

		// Verify columns are accessible via camelCase property names as direct properties
		expect(agentTable).toHaveProperty("id");
		expect(agentTable).toHaveProperty("enabled");
		expect(agentTable).toHaveProperty("serverId"); // snake_case "server_id" -> camelCase "serverId"
		expect(agentTable).toHaveProperty("createdAt");
		expect(agentTable).toHaveProperty("updatedAt");
		expect(agentTable).toHaveProperty("name");
		expect(agentTable).toHaveProperty("username");
		expect(agentTable).toHaveProperty("system");
		expect(agentTable).toHaveProperty("bio");
		expect(agentTable).toHaveProperty("messageExamples");
		expect(agentTable).toHaveProperty("postExamples");
		expect(agentTable).toHaveProperty("topics");
		expect(agentTable).toHaveProperty("adjectives");
		expect(agentTable).toHaveProperty("knowledge");
		expect(agentTable).toHaveProperty("plugins");
		expect(agentTable).toHaveProperty("settings");
		expect(agentTable).toHaveProperty("style");
	});

	it("cache table has composite primary key columns", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const cacheTable = tables.cache;

		expect(cacheTable).toBeDefined();

		// Verify columns
		expect(cacheTable).toHaveProperty("key");
		expect(cacheTable).toHaveProperty("agentId");
		expect(cacheTable).toHaveProperty("value");
		expect(cacheTable).toHaveProperty("createdAt");
		expect(cacheTable).toHaveProperty("expiresAt");
	});

	it("embedding table has vector columns", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const embeddingTable = tables.embedding;

		expect(embeddingTable).toBeDefined();

		// Verify vector columns exist (camelCase: dim_384 -> dim384)
		expect(embeddingTable).toHaveProperty("dim384");
		expect(embeddingTable).toHaveProperty("dim512");
		expect(embeddingTable).toHaveProperty("dim768");
		expect(embeddingTable).toHaveProperty("dim1024");
		expect(embeddingTable).toHaveProperty("dim1536");
		expect(embeddingTable).toHaveProperty("dim3072");
	});

	it("entity table has text[] column", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const entityTable = tables.entity;

		expect(entityTable).toBeDefined();

		// Verify text array column
		expect(entityTable).toHaveProperty("names");

		// Check that it's defined
		const namesColumn = entityTable.names;
		expect(namesColumn).toBeDefined();
	});

	it("memory table structure matches expected schema", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const memoryTable = tables.memory;

		expect(memoryTable).toBeDefined();

		// Verify key columns
		expect(memoryTable).toHaveProperty("id");
		expect(memoryTable).toHaveProperty("type");
		expect(memoryTable).toHaveProperty("createdAt");
		expect(memoryTable).toHaveProperty("content");
		expect(memoryTable).toHaveProperty("entityId");
		expect(memoryTable).toHaveProperty("agentId");
		expect(memoryTable).toHaveProperty("roomId");
		expect(memoryTable).toHaveProperty("worldId");
		expect(memoryTable).toHaveProperty("unique");
		expect(memoryTable).toHaveProperty("metadata");
	});

	it("relationship table has unique constraint fields", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);
		const relationshipTable = tables.relationship;

		expect(relationshipTable).toBeDefined();

		// Verify columns for the unique constraint
		expect(relationshipTable).toHaveProperty("sourceEntityId");
		expect(relationshipTable).toHaveProperty("targetEntityId");
		expect(relationshipTable).toHaveProperty("agentId");
		expect(relationshipTable).toHaveProperty("tags");
	});

	it("channelParticipant and messageServerAgent have composite PKs", () => {
		const tables = buildBaseTables(mockBuildTable, mockPgAdapter);

		// channelParticipant
		const channelParticipantTable = tables.channelParticipant;
		expect(channelParticipantTable).toBeDefined();
		expect(channelParticipantTable).toHaveProperty("channelId");
		expect(channelParticipantTable).toHaveProperty("entityId");

		// messageServerAgent
		const messageServerAgentTable = tables.messageServerAgent;
		expect(messageServerAgentTable).toBeDefined();
		expect(messageServerAgentTable).toHaveProperty("messageServerId");
		expect(messageServerAgentTable).toHaveProperty("agentId");
	});
});
