/**
 * Fail-closed canonical recall tests for the production stored-message search.
 * This suite deliberately makes no Gmail/calendar ingestion claim: those
 * sources do not have a production canonical-memory caller yet.
 */
import {
	canonicalDedupeKey,
	ChannelType,
	type CanonicalRecallPolicy,
	deriveCanonicalProvenance,
	type IAgentRuntime,
	type Memory,
	resolveRecallDestination,
	searchCanonicalConversationMemories,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messageAction } from "../../../core/src/features/advanced-capabilities/actions/message.ts";
import { type MockLlmRuntime, withMockLlmRuntime } from "../index.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
	vi.restoreAllMocks();
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
	cleanups.push(harness.cleanup);
	return harness;
}

function id(seed: string): UUID {
	return stringToUuid(seed) as UUID;
}

async function createRoom(
	runtime: IAgentRuntime,
	roomId: UUID,
	type: ChannelType,
	participants: UUID[] = [],
): Promise<void> {
	// Rooms are world-scoped in production; the adapter rejects an unparented
	// room. Give each room its own world so destination resolution reads the
	// same shape it sees on a real Discord/Telegram surface.
	const worldId = id(`world-${roomId}`);
	await runtime.createWorld({ id: worldId, agentId: runtime.agentId });
	await runtime.createRoom({ id: roomId, source: "test", type, worldId });
	for (const participant of participants) {
		// Participants are FK-constrained to real entities, so register the
		// sender before joining it to the room.
		await runtime.createEntity({
			id: participant,
			names: [`entity-${participant}`],
			agentId: runtime.agentId,
		});
		await runtime.addParticipant(participant, roomId);
	}
}

type MemoryOverrides = Omit<Partial<Memory>, "content" | "metadata"> & {
	content?: Partial<Memory["content"]>;
	metadata?: Record<string, unknown>;
};

function messageMemory(overrides: MemoryOverrides = {}): Memory {
	const roomId = overrides.roomId ?? id("source-room");
	const entityId = overrides.entityId ?? id("sender");
	const content = overrides.content ?? {};
	const metadata = overrides.metadata ?? {};
	return {
		id: id(`memory-${roomId}-${entityId}`),
		entityId,
		agentId: id("agent"),
		roomId,
		createdAt: 1_700_000_000_000,
		...overrides,
		content: {
			text: "The deploy key rotates on Friday.",
			source: "discord",
			...content,
		},
		metadata: {
			type: "message",
			provider: "discord",
			accountId: "discord-account-1",
			scope: "global",
			messageIdFull: "discord-message-1",
			discord: { userId: "discord-user-1" },
			...metadata,
		} as Memory["metadata"],
	};
}

describe("canonical stored-message recall", () => {
	it.each([
		["source", (memory: Memory) => {
			delete (memory.metadata as Record<string, unknown>).provider;
			delete (memory.content as Record<string, unknown>).source;
		}],
		["account", (memory: Memory) => {
			delete (memory.metadata as Record<string, unknown>).accountId;
		}],
		["platform record", (memory: Memory) => {
			delete (memory.metadata as Record<string, unknown>).messageIdFull;
		}],
		["timestamp", (memory: Memory) => {
			delete memory.createdAt;
		}],
		["scope", (memory: Memory) => {
			delete (memory.metadata as Record<string, unknown>).scope;
		}],
	])("returns typed invalid provenance for missing %s", (_field, mutate) => {
		const memory = messageMemory();
		mutate(memory);
		const provenance = deriveCanonicalProvenance(memory, id("agent"));
		expect(provenance).toEqual(
			expect.objectContaining({
				valid: false,
				code: "invalid_provenance",
			}),
		);
		if (!provenance.valid) {
			expect(provenance.reason).toContain(_field.split(" ")[0]);
		}
	});

	it("withholds missing scope instead of fabricating global access", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const roomId = id("missing-scope-room");
		await createRoom(runtime, roomId, ChannelType.DM, [id("sender")]);
		const candidate = messageMemory({ agentId: runtime.agentId, roomId });
		delete (candidate.metadata as Record<string, unknown>).scope;
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([candidate]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("sender") },
			destinationRoomId: roomId,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.availability).toBe("unavailable");
		expect(recall.sources).toEqual([
			expect.objectContaining({ source: "messages", state: "ok" }),
		]);
		expect(recall.withheld[0]).toEqual(
			expect.objectContaining({
				code: "invalid_provenance",
				reason: expect.stringContaining("scope"),
			}),
		);
	});

	it("runs mandatory scope authorization before a permissive destination policy", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const roomId = id("scope-before-policy-room");
		await createRoom(runtime, roomId, ChannelType.DM, [id("ordinary-user")]);
		const policy: CanonicalRecallPolicy = {
			id: "permissive-test-policy",
			decide: vi.fn(() => ({ allow: true })),
		};
		const ownerScoped = messageMemory({
			agentId: runtime.agentId,
			roomId,
			entityId: id("owner"),
			metadata: { scope: "owner-private" },
		});
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([ownerScoped]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("ordinary-user"), role: "USER" },
			destinationRoomId: roomId,
			count: 10,
			policy,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.withheld[0]?.code).toBe("scope_denied");
		expect(policy.decide).not.toHaveBeenCalled();
	});

	it("resolves destination audience from trusted runtime room metadata", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const roomId = id("trusted-group-room");
		const participants = [id("requester"), id("other-participant")];
		await createRoom(runtime, roomId, ChannelType.GROUP, participants);

		const destination = await resolveRecallDestination(runtime, roomId);

		expect(destination).toEqual(
			expect.objectContaining({
				roomId,
				chatType: ChannelType.GROUP,
				isGroup: true,
				participantEntityIds: expect.arrayContaining(participants),
			}),
		);
	});

	it("derives unavailable health from adapter failure", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		vi.spyOn(runtime, "searchMemories").mockRejectedValue(
			new Error("adapter offline"),
		);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("requester") },
			destinationRoomId: id("missing-destination"),
			count: 10,
			source: "discord",
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.availability).toBe("unavailable");
		expect(recall.sources).toEqual([
			expect.objectContaining({
				source: "messages",
				state: "unavailable",
				reason: "adapter offline",
			}),
		]);
	});

	it("fails closed when trusted destination lookup fails after a healthy search", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([
			messageMemory({ agentId: runtime.agentId }),
		]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("sender") },
			destinationRoomId: id("unresolvable-destination"),
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.availability).toBe("unavailable");
		expect(recall.sources[0]).toEqual(
			expect.objectContaining({ source: "messages", state: "ok" }),
		);
		expect(recall.withheld[0]?.code).toBe("destination_unresolved");
	});

	it("dedupes by source/account/platform id across distinct database primary keys", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const roomId = id("dedupe-room");
		await createRoom(runtime, roomId, ChannelType.DM, [id("sender")]);
		const first = messageMemory({
			id: id("duplicate-memory-a"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_000_000,
		});
		const second = messageMemory({
			id: id("duplicate-memory-b"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_010_000,
		});
		expect(first.id).not.toBe(second.id);
		const firstProvenance = deriveCanonicalProvenance(first, runtime.agentId);
		const secondProvenance = deriveCanonicalProvenance(second, runtime.agentId);
		expect(firstProvenance.valid).toBe(true);
		expect(secondProvenance.valid).toBe(true);
		if (!firstProvenance.valid || !secondProvenance.valid) return;
		expect(canonicalDedupeKey(firstProvenance.provenance)).toBe(
			canonicalDedupeKey(secondProvenance.provenance),
		);
		// Same platform record under a DIFFERENT account: account identity is
		// part of the canonical key and must never be squashed. Two accounts
		// relaying the same platform message are two facts, not one.
		const otherAccount = messageMemory({
			id: id("duplicate-memory-c"),
			agentId: runtime.agentId,
			roomId,
			createdAt: 1_700_000_020_000,
			metadata: { accountId: "discord-account-2" },
		});
		const otherProvenance = deriveCanonicalProvenance(
			otherAccount,
			runtime.agentId,
		);
		expect(otherProvenance.valid).toBe(true);
		if (!otherProvenance.valid) return;
		expect(canonicalDedupeKey(otherProvenance.provenance)).not.toBe(
			canonicalDedupeKey(firstProvenance.provenance),
		);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([
			second,
			first,
			otherAccount,
		]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("sender") },
			destinationRoomId: roomId,
			count: 10,
		});

		expect(recall.items).toHaveLength(2);
		expect(recall.items[0]?.memory.id).toBe(first.id);
		expect(
			recall.items.map((item) => item.provenance.accountId).sort(),
		).toEqual(["discord-account-1", "discord-account-2"]);
	});

	it("uses the real PGLite adapter on the production MESSAGE search path", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const roomId = id("production-search-room");
		const requester = id("requester");
		await createRoom(runtime, roomId, ChannelType.DM, [requester]);
		const embedding = new Array<number>(384).fill(0.1);
		const first = messageMemory({
			id: id("production-duplicate-a"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			createdAt: 1_700_000_000_000,
			embedding,
		});
		const second = messageMemory({
			id: id("production-duplicate-b"),
			agentId: runtime.agentId,
			roomId,
			entityId: requester,
			createdAt: 1_700_000_010_000,
			embedding,
		});
		await runtime.createMemory(first, "messages", false);
		await runtime.createMemory(second, "messages", false);
		vi.spyOn(runtime, "useModel").mockResolvedValue(embedding as never);
		const searchSpy = vi.spyOn(runtime, "searchMemories");

		const result = await messageAction.handler(
			runtime,
			messageMemory({
				id: id("production-request"),
				agentId: runtime.agentId,
				roomId,
				entityId: requester,
				content: { text: "Find deploy key", source: "client_chat" },
			}),
			undefined,
			{ parameters: { action: "search", query: "deploy key" } },
			undefined,
			undefined,
		);
		if (!result) throw new Error("MESSAGE handler returned no result");

		expect(searchSpy).toHaveBeenCalledTimes(1);
		expect(result.success).toBe(true);
		const data = result.data as {
			results?: Array<{ id: UUID }>;
			availability?: string;
			withheld?: unknown[];
			sources?: Array<{ source: string; state: string }>;
		};
		expect(data.results).toHaveLength(1);
		expect(data.results?.[0]?.id).toBe(first.id);
		expect(data.availability).toBe("complete");
		expect(data.withheld).toEqual([]);
		expect(data.sources).toEqual([
			expect.objectContaining({ source: "messages", state: "ok" }),
		]);
	});

	it("default policy denies every cross-room disclosure pending PR #17212", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const destinationRoomId = id("destination-room");
		await createRoom(runtime, destinationRoomId, ChannelType.DM, [id("sender")]);
		vi.spyOn(runtime, "searchMemories").mockResolvedValue([
			messageMemory({ agentId: runtime.agentId, roomId: id("source-room") }),
		]);

		const recall = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			agentId: runtime.agentId,
			requester: { requesterEntityId: id("sender") },
			destinationRoomId,
			count: 10,
		});

		expect(recall.items).toHaveLength(0);
		expect(recall.withheld[0]?.code).toBe("policy_contract_pending");
	});
});
