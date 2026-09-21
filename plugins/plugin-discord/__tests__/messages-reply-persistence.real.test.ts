import { randomUUID } from "node:crypto";
import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDiscordMessageMemoryOnce } from "../messages.ts";
import {
	createTestRuntime,
	type TestRuntimeResult,
} from "../test/helpers/pglite-runtime.ts";

let fixture: TestRuntimeResult;
let roomId: UUID;
beforeAll(async () => {
	fixture = await createTestRuntime();
	roomId = randomUUID() as UUID;
	await fixture.runtime.createRooms([
		{
			id: roomId,
			agentId: fixture.runtime.agentId,
			source: "discord",
			type: ChannelType.DM,
		},
	]);
}, 180_000);
afterAll(async () => {
	await fixture?.cleanup();
});

function reply(): Memory & { id: UUID } {
	return {
		id: randomUUID() as UUID,
		agentId: fixture.runtime.agentId,
		entityId: fixture.runtime.agentId,
		roomId,
		content: { text: "Original reply", actions: ["REPLY"] },
	};
}

describe("canonical Discord delivery with real SQL persistence", () => {
	it("keeps delivery details when core saves after the connector", async () => {
		const core = reply();
		const delivered: Memory = {
			...core,
			content: {
				...core.content,
				source: "discord",
				url: "https://discord.com/channels/test/reply",
			},
		};
		await createDiscordMessageMemoryOnce(fixture.runtime, delivered, {
			operation: "test",
			mergeIntoExisting: true,
		});
		await fixture.runtime.createMemory(core, "messages");
		await createDiscordMessageMemoryOnce(fixture.runtime, delivered, {
			operation: "retry",
			mergeIntoExisting: true,
		});
		const rows = await fixture.runtime.getMemories({
			roomId,
			tableName: "messages",
			count: 100,
		});
		expect(rows.filter((row) => row.id === core.id)).toHaveLength(1);
		expect(
			(await fixture.runtime.getMemoryById(core.id))?.content,
		).toMatchObject(delivered.content);
	});

	it("reports rejected delivery metadata updates instead of claiming persistence", async () => {
		const core = reply();
		await fixture.runtime.createMemory(core, "messages");
		const runtime = fixture.runtime;
		await expect(
			createDiscordMessageMemoryOnce(
				{
					agentId: runtime.agentId,
					logger: runtime.logger,
					getMemoryById: runtime.getMemoryById.bind(runtime),
					createMemory: runtime.createMemory.bind(runtime),
					updateMemory: async () => false,
				},
				core,
				{ operation: "test", mergeIntoExisting: true },
			),
		).rejects.toThrow("metadata was not persisted");
	});

	it("retains core content and delivery metadata when core inserts between lookup and insert", async () => {
		const runtime = fixture.runtime;
		const core = reply();
		let firstLookup = true;
		const deliveryRuntime = {
			agentId: runtime.agentId,
			logger: runtime.logger,
			getMemoryById: async (id: UUID) => {
				const row = await runtime.getMemoryById(id);
				if (firstLookup) {
					firstLookup = false;
					await runtime.createMemory(core, "messages");
				}
				return row;
			},
			createMemory: runtime.createMemory.bind(runtime),
			updateMemory: runtime.updateMemory.bind(runtime),
		};
		await createDiscordMessageMemoryOnce(
			deliveryRuntime,
			{
				...core,
				content: {
					text: "Transport text",
					source: "discord",
					url: "https://discord.com/channels/test/reply",
				},
				metadata: { type: "message", platformMessageIds: ["123", "456"] },
			},
			{ operation: "test", mergeIntoExisting: true },
		);
		const stored = await runtime.getMemoryById(core.id);
		expect(stored?.content).toMatchObject({
			text: "Original reply",
			actions: ["REPLY"],
			source: "discord",
			url: "https://discord.com/channels/test/reply",
		});
		expect(stored?.metadata).toMatchObject({
			platformMessageIds: ["123", "456"],
		});
	});

	it.each(["roomId", "entityId", "agentId"] as const)(
		"refuses a mismatched %s",
		async (field) => {
			const core = reply();
			await fixture.runtime.createMemory(core, "messages");
			await expect(
				createDiscordMessageMemoryOnce(
					fixture.runtime,
					{ ...core, [field]: randomUUID() as UUID },
					{ operation: "test", mergeIntoExisting: true },
				),
			).rejects.toThrow("ownership");
			expect((await fixture.runtime.getMemoryById(core.id))?.content).toEqual(
				core.content,
			);
		},
	);
});
