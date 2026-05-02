import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";

function createRuntime(
	options: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "Native Feature Test Agent",
			username: "native-feature-test-agent",
			clients: [],
			settings: {},
		},
		adapter: new InMemoryDatabaseAdapter(),
		...options,
	});
}

describe("native runtime features", () => {
	it("registers knowledge, relationships, and trajectories by default", async () => {
		const runtime = createRuntime();

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		expect(runtime.isKnowledgeEnabled()).toBe(true);
		expect(runtime.isRelationshipsEnabled()).toBe(true);
		expect(runtime.isTrajectoriesEnabled()).toBe(true);
		expect(runtime.plugins.map((plugin) => plugin.name)).toEqual(
			expect.arrayContaining(["knowledge", "relationships", "trajectories"]),
		);
		expect(runtime.hasService("knowledge")).toBe(true);
		expect(runtime.hasService("relationships")).toBe(true);
		expect(runtime.hasService("trajectories")).toBe(true);
	});

	it("respects constructor feature disable flags", async () => {
		const runtime = createRuntime({
			enableKnowledge: false,
			enableRelationships: false,
			enableTrajectories: false,
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		expect(runtime.isKnowledgeEnabled()).toBe(false);
		expect(runtime.isRelationshipsEnabled()).toBe(false);
		expect(runtime.isTrajectoriesEnabled()).toBe(false);
		expect(runtime.plugins.map((plugin) => plugin.name)).not.toEqual(
			expect.arrayContaining(["knowledge", "relationships", "trajectories"]),
		);
		expect(runtime.hasService("knowledge")).toBe(false);
		expect(runtime.hasService("relationships")).toBe(false);
		expect(runtime.hasService("trajectories")).toBe(false);
	});

	it("supports runtime toggling", async () => {
		const runtime = createRuntime({
			enableKnowledge: false,
			enableTrajectories: false,
		});

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		// Relationships plugin is registered when the feature is enabled, but
		// RelationshipsService may fail to start with InMemoryDatabaseAdapter
		// (no relationships world). Toggle tests only need registration + flags.
		expect(runtime.isRelationshipsEnabled()).toBe(true);
		expect(runtime.hasService("relationships")).toBe(true);

		await runtime.disableRelationships();
		expect(runtime.isRelationshipsEnabled()).toBe(false);
		expect(runtime.hasService("relationships")).toBe(false);

		await runtime.enableKnowledge();
		expect(runtime.isKnowledgeEnabled()).toBe(true);
		expect(runtime.hasService("knowledge")).toBe(true);
	});
});
