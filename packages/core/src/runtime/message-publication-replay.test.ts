/** Real SQLite coverage for host admission followed by assistant message publication. */

import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../types";
import { stripAugmentationForPersistence } from "../utils/message-text";
import {
	RuntimeDataMutations,
	type RuntimeDataMutationsHost,
} from "./data-mutations";
import { buildMessageContentProjection } from "./message-content-segments";

const agentId = "22222222-2222-4222-8222-222222222222" as UUID;
const roomId = "44444444-4444-4444-8444-444444444444" as UUID;
const entityId = "33333333-3333-4333-8333-333333333333" as UUID;
function message(text = "Open Calendar"): Memory & { id: UUID } {
	return {
		id: "11111111-1111-4111-8111-111111111111" as UUID,
		agentId,
		roomId,
		entityId,
		createdAt: 1700000000000,
		content: { text },
		metadata: { type: "message", scope: "room" },
	};
}
async function fixture() {
	const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
	await adapter.createRoomParticipants([entityId], roomId);
	const hook = vi.fn(async () => undefined);
	const runtime = {
		agentId,
		adapter,
		applyPipelineHooks: hook,
	} as unknown as IAgentRuntime;
	const host = {
		getSecretsForRedaction: () => ({}),
		roomMessagesMemo: () => ({ invalidate() {} }),
	} as unknown as RuntimeDataMutationsHost;
	return { adapter, hook, mutations: new RuntimeDataMutations(runtime, host) };
}
describe("exact message publication replay", () => {
	it("retains request routing in memory but excludes it from exact durable replay", async () => {
		const { adapter, mutations } = await fixture();
		const m = message();
		await adapter.createMemories([{ memory: m, tableName: "messages" }]);
		const routed = {
			...m,
			content: { ...m.content, metadata: { viewClientId: "qa-browser" } },
		};
		const durable = stripAugmentationForPersistence(routed);
		expect(routed.content.metadata.viewClientId).toBe("qa-browser");
		expect(durable.content.metadata).toBeUndefined();
		await expect(mutations.createMessageMemory(durable)).resolves.toBe(m.id);
	});
	it("preserves non-routing metadata while stripping transport and language wrappers", () => {
		const routed = {
			...message(),
			content: {
				text: "Open Calendar\n\n[Language instruction: Reply in English.]",
				metadata: { viewClientId: "qa-browser", sourceLabel: "retained" },
			},
		};
		expect(stripAugmentationForPersistence(routed).content).toEqual({
			text: "Open Calendar",
			metadata: { sourceLabel: "retained" },
		});
	});

	it("accepts the exact small message already admitted by the host without another hook", async () => {
		const { adapter, mutations, hook } = await fixture();
		const m = message();
		await adapter.createMemories([{ memory: m, tableName: "messages" }]);
		await expect(mutations.createMessageMemory(m)).resolves.toBe(m.id);
		expect(hook).not.toHaveBeenCalled();
	});
	it("accepts exact segmented replay without repeating persistence hooks", async () => {
		const { mutations, hook } = await fixture();
		const m = message("complete original 🙂".repeat(10000));
		await mutations.createMessageMemory(m);
		await expect(mutations.createMessageMemory(m)).resolves.toBe(m.id);
		expect(hook).toHaveBeenCalledTimes(1);
	});
	it("accepts host-admitted replay with adapter-generated timestamp and empty metadata", async () => {
		const { adapter, mutations, hook } = await fixture();
		const m = message();
		delete m.createdAt;
		delete m.metadata;
		await adapter.createMemories([{ memory: m, tableName: "messages" }]);
		await expect(mutations.createMessageMemory(m)).resolves.toBe(m.id);
		expect(hook).not.toHaveBeenCalled();
	});
	it.each([
		["small", "Open Calendar"],
		["segmented", "complete original 🙂".repeat(10000)],
	])(
		"rejects changed timestamp or memory metadata on %s replay",
		async (_, text) => {
			const { adapter, mutations, hook } = await fixture();
			const m = message(text);
			await mutations.createMessageMemory(m);
			for (const changed of [
				{ ...m, createdAt: 1700000000001 },
				{ ...m, metadata: { ...m.metadata, scope: "private" } },
				{ ...m, metadata: undefined },
			] as Memory[]) {
				await expect(
					mutations.createMessageMemory(changed),
				).rejects.toMatchObject({
					code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
				});
			}
			const [stored] = await adapter.getMemoriesByIds([m.id], "messages");
			expect(stored.createdAt).toBe(m.createdAt);
			expect(stored.metadata).toEqual(m.metadata);
			expect(hook).toHaveBeenCalledTimes(1);
		},
	);
	it("rejects a replay if an immutable segment is missing", async () => {
		const { adapter, mutations } = await fixture();
		const m = message("segment evidence 🙂".repeat(10000));
		await mutations.createMessageMemory(m);
		const segment = buildMessageContentProjection({ ...m, id: m.id })
			.segments[0];
		expect(segment).toBeDefined();
		await adapter.deleteMemories([segment.id as UUID]);
		await expect(mutations.createMessageMemory(m)).rejects.toMatchObject({
			code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
		});
	});
	it.each(["content", "entityId", "roomId", "agentId"] as const)(
		"rejects a collision with changed %s",
		async (field) => {
			const { mutations } = await fixture();
			const m = message();
			await mutations.createMessageMemory(m);
			const changed = {
				...m,
				[field]:
					field === "content"
						? { text: "Different request" }
						: "55555555-5555-4555-8555-555555555555",
			} as Memory;
			await expect(
				mutations.createMessageMemory(changed),
			).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
		},
	);
});
