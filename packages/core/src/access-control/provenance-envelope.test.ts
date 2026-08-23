/**
 * Unit tests for canonical memory provenance envelope, deduplication, and recall filtering.
 */

import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types/index.js";
import {
	buildCanonicalRecall,
	type CanonicalProvenance,
	canonicalDedupeKey,
	deriveCanonicalProvenance,
} from "./provenance-envelope.js";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const USER_ID = "22222222-2222-2222-2222-222222222222" as UUID;

function makeMemory(overrides: Partial<Memory> = {}): Memory {
	return {
		id: "mem-1" as UUID,
		entityId: USER_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		createdAt: 1000,
		content: { text: "Hello world" },
		metadata: {
			provider: "discord",
			accountId: "acc-1",
			platformMessageId: "plat-msg-100",
			scope: "shared",
			discord: {
				userId: "discord-user-1",
				name: "Alice",
			},
		},
		...overrides,
	};
}

describe("deriveCanonicalProvenance", () => {
	it("derives valid canonical provenance from well-formed memory", () => {
		const memory = makeMemory();
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.source).toBe("discord");
			expect(result.provenance.accountId).toBe("acc-1");
			expect(result.provenance.platformMessageId).toBe("plat-msg-100");
			expect(result.provenance.scope).toBe("shared");
			expect(result.provenance.trust).toBe("sender-stamped");
			expect(result.provenance.senderPlatformId).toBe("discord-user-1");
		}
	});

	it("marks agent own messages as self trust", () => {
		const memory = makeMemory({
			entityId: AGENT_ID,
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.trust).toBe("self");
		}
	});

	it("marks messages without nested connector identity as unverified trust", () => {
		const memory = makeMemory({
			metadata: {
				provider: "telegram",
				accountId: "bot-1",
				platformMessageId: "999",
				scope: "room",
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.trust).toBe("unverified");
		}
	});

	it("rejects memories with missing required provenance fields", () => {
		// Missing source
		const noSource = makeMemory({
			metadata: { accountId: "acc", platformMessageId: "1", scope: "shared" },
		});
		expect(deriveCanonicalProvenance(noSource, AGENT_ID).valid).toBe(false);

		// Missing accountId
		const noAccount = makeMemory({
			metadata: {
				provider: "discord",
				platformMessageId: "1",
				scope: "shared",
			},
		});
		expect(deriveCanonicalProvenance(noAccount, AGENT_ID).valid).toBe(false);

		// Missing platformMessageId
		const noPmi = makeMemory({
			metadata: { provider: "discord", accountId: "acc", scope: "shared" },
		});
		expect(deriveCanonicalProvenance(noPmi, AGENT_ID).valid).toBe(false);

		// Missing scope
		const noScope = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "acc",
				platformMessageId: "1",
			},
		});
		expect(deriveCanonicalProvenance(noScope, AGENT_ID).valid).toBe(false);
	});

	it("rejects memories with conflicting source definitions", () => {
		const conflict = makeMemory({
			content: { text: "hi", source: "telegram" },
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "1",
				scope: "shared",
			},
		});
		const result = deriveCanonicalProvenance(conflict, AGENT_ID);
		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.reason).toContain("conflicting source");
		}
	});
});

describe("canonicalDedupeKey", () => {
	it("formats colon-separated key for standard identifiers", () => {
		const provenance: CanonicalProvenance = {
			source: "discord",
			accountId: "acc1",
			roomId: "room1" as UUID,
			senderId: "user1" as UUID,
			timestampMs: 1000,
			trust: "self",
			platformMessageId: "msg1",
			scope: "shared",
		};

		expect(canonicalDedupeKey(provenance)).toBe("discord:acc1:room1:msg1");
	});

	it("formats versioned v2 JSON tuple when identifiers contain colons", () => {
		const provenance: CanonicalProvenance = {
			source: "discord",
			accountId: "server:channel:acc",
			roomId: "room1" as UUID,
			senderId: "user1" as UUID,
			timestampMs: 1000,
			trust: "self",
			platformMessageId: "msg1",
			scope: "shared",
		};

		const key = canonicalDedupeKey(provenance);
		expect(key.startsWith("v2|")).toBe(true);
		expect(key).toContain("server:channel:acc");
	});
});

describe("buildCanonicalRecall", () => {
	it("deduplicates identical deliveries and filters invalid provenance", () => {
		const mem1 = makeMemory({
			id: "mem-1" as UUID,
			createdAt: 1000,
		});
		const duplicateMem1 = makeMemory({
			id: "mem-1-dup" as UUID,
			createdAt: 1500,
		});
		const invalidMem = makeMemory({
			id: "mem-invalid" as UUID,
			metadata: {}, // missing required provenance
		});

		const result = buildCanonicalRecall({
			candidates: [mem1, duplicateMem1, invalidMem],
			agentId: AGENT_ID,
			destinationRoomId: ROOM_ID,
			requester: {
				role: "owner",
				entityId: USER_ID,
				agentId: AGENT_ID,
				isOwner: true,
			},
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].memory.id).toBe("mem-1");
		expect(result.withheld).toHaveLength(1);
		expect(result.withheld[0].code).toBe("invalid_provenance");
	});
});

/**
 * Additive branch coverage: readString coercion and trim semantics,
 * connector-source normalization and key validation, nested identity lookup
 * under the canonical source key, display-name precedence, passthrough
 * fields, timestamp and scope validation, secondary message-id agreement, v2
 * tuple structure, recall ordering / tie-breaking / cross-room and scope
 * withholding, aggregate identifier-free withheld entries, empty candidate
 * sets, and the fail-closed unbound-delivery-turn behavior of
 * searchCanonicalConversationMemories.
 */

function discordMeta(platformMessageId: string) {
	return {
		provider: "discord",
		accountId: "acc-1",
		platformMessageId,
		scope: "shared",
		discord: { userId: "discord-user-1", name: "Alice" },
	};
}

describe("deriveCanonicalProvenance field coercion and normalization", () => {
	it("coerces numeric telegram-style identifiers to strings", () => {
		const memory = makeMemory({
			metadata: {
				provider: "telegram",
				accountId: 987654321,
				platformMessageId: 42,
				scope: "room",
				chatType: "group",
				telegram: { userId: 555000111, name: "Bob" },
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.source).toBe("telegram");
			expect(result.provenance.accountId).toBe("987654321");
			expect(result.provenance.platformMessageId).toBe("42");
			expect(result.provenance.senderPlatformId).toBe("555000111");
			expect(result.provenance.senderDisplayName).toBe("Bob");
			expect(result.provenance.trust).toBe("sender-stamped");
			expect(result.provenance.chatType).toBe("group");
			expect(result.provenance.scope).toBe("room");
		}
	});

	it("treats whitespace-only strings as missing required fields", () => {
		const blankProvider = makeMemory({
			metadata: {
				provider: "   ",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
			},
		});
		const providerResult = deriveCanonicalProvenance(blankProvider, AGENT_ID);
		expect(providerResult.valid).toBe(false);
		if (!providerResult.valid) {
			expect(providerResult.reason).toContain("missing a valid source");
		}

		const blankAccount = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "   ",
				platformMessageId: "pmi-1",
				scope: "shared",
			},
		});
		const accountResult = deriveCanonicalProvenance(blankAccount, AGENT_ID);
		expect(accountResult.valid).toBe(false);
		if (!accountResult.valid) {
			expect(accountResult.reason).toContain(
				"missing a connector account id",
			);
		}
	});

	it("normalizes source casing and resolves nested identity under the canonical key", () => {
		const memory = makeMemory({
			metadata: {
				provider: "Discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
				discord: { userId: "u-1" },
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.rawSource).toBe("Discord");
			expect(result.provenance.source).toBe("discord");
			expect(result.provenance.senderPlatformId).toBe("u-1");
			expect(result.provenance.trust).toBe("sender-stamped");
		}
	});

	it("treats differently-cased duplicate source paths as one surface, not a conflict", () => {
		const memory = makeMemory({
			content: { text: "hi", source: "DISCORD" },
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.source).toBe("discord");
		}
	});

	it("rejects sources that are not valid registry keys", () => {
		const memory = makeMemory({
			metadata: {
				provider: "not a source!",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.code).toBe("invalid_provenance");
			expect(result.reason).toContain("missing a valid source");
		}
	});

	it("prefers metadata.sender.name over nested identity names", () => {
		const memory = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
				sender: { name: "Carol" },
				discord: { userId: "u-1", name: "NestedName" },
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.senderDisplayName).toBe("Carol");
		}
	});

	it("falls back to sender.username then metadata.entityName for display name", () => {
		const usernameOnly = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
				sender: { username: "carol_un" },
				discord: { userId: "u-1" },
			},
		});
		const usernameResult = deriveCanonicalProvenance(usernameOnly, AGENT_ID);
		expect(usernameResult.valid).toBe(true);
		if (usernameResult.valid) {
			expect(usernameResult.provenance.senderDisplayName).toBe("carol_un");
		}

		const entityNameOnly = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "shared",
				entityName: "Entity Fallback",
				discord: { userId: "u-1" },
			},
		});
		const entityResult = deriveCanonicalProvenance(entityNameOnly, AGENT_ID);
		expect(entityResult.valid).toBe(true);
		if (entityResult.valid) {
			expect(entityResult.provenance.senderDisplayName).toBe(
				"Entity Fallback",
			);
		}
	});

	it("passes worldId through from the stored memory", () => {
		const worldId = "33333333-3333-3333-3333-333333333333" as UUID;
		const result = deriveCanonicalProvenance(
			makeMemory({ worldId }),
			AGENT_ID,
		);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.worldId).toBe(worldId);
		}
	});

	it("rejects non-positive, non-finite, and non-numeric timestamps", () => {
		const badTimestamps: unknown[] = [0, -50, Number.NaN, "1000"];
		for (const createdAt of badTimestamps) {
			const result = deriveCanonicalProvenance(
				makeMemory({ createdAt: createdAt as number }),
				AGENT_ID,
			);
			expect(result.valid).toBe(false);
			if (!result.valid) {
				expect(result.reason).toContain("missing a valid timestamp");
			}
		}
	});

	it("rejects scope strings outside the canonical MemoryScope set", () => {
		const memory = makeMemory({
			metadata: {
				provider: "discord",
				accountId: "acc-1",
				platformMessageId: "pmi-1",
				scope: "workspace",
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(false);
		if (!result.valid) {
			expect(result.code).toBe("invalid_provenance");
			expect(result.reason).toContain("missing a valid scope");
		}
	});

	it("accepts agreeing secondary message-id paths without a top-level id", () => {
		const memory = makeMemory({
			metadata: {
				provider: "telegram",
				accountId: "bot-1",
				messageIdFull: "777",
				scope: "shared",
				telegram: { messageId: "777" },
			},
		});
		const result = deriveCanonicalProvenance(memory, AGENT_ID);

		expect(result.valid).toBe(true);
		if (result.valid) {
			expect(result.provenance.platformMessageId).toBe("777");
		}
	});
});

describe("canonicalDedupeKey v2 tuple structure", () => {
	it("round-trips delimiter-bearing identifiers through the versioned JSON tuple", () => {
		const roomId = "44444444-4444-4444-4444-444444444444" as UUID;
		const provenance: CanonicalProvenance = {
			source: "slack",
			accountId: "team:channel:acct",
			roomId,
			senderId: USER_ID,
			timestampMs: 1000,
			trust: "sender-stamped",
			platformMessageId: "msg:42:tail",
			scope: "shared",
		};

		const key = canonicalDedupeKey(provenance);
		expect(key.startsWith("v2|")).toBe(true);
		expect(JSON.parse(key.slice(3))).toEqual([
			"slack",
			"team:channel:acct",
			roomId,
			"msg:42:tail",
		]);
	});
});

describe("buildCanonicalRecall ordering, withholding, and aggregation", () => {
	it("returns items sorted ascending by creation timestamp", () => {
		const result = buildCanonicalRecall({
			candidates: [
				makeMemory({
					id: "mem-c" as UUID,
					createdAt: 3000,
					metadata: discordMeta("pmi-3"),
				}),
				makeMemory({
					id: "mem-a" as UUID,
					createdAt: 1000,
					metadata: discordMeta("pmi-1"),
				}),
				makeMemory({
					id: "mem-b" as UUID,
					createdAt: 2000,
					metadata: discordMeta("pmi-2"),
				}),
			],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});

		expect(result.items.map((item) => item.memory.id)).toEqual([
			"mem-a",
			"mem-b",
			"mem-c",
		]);
	});

	it("keeps the first-seen candidate when timestamps tie within one dedupe group", () => {
		const firstSeen = makeMemory({
			id: "mem-tie-first" as UUID,
			createdAt: 500,
			metadata: discordMeta("tie-pmi"),
		});
		const secondSeen = makeMemory({
			id: "mem-tie-second" as UUID,
			createdAt: 500,
			metadata: discordMeta("tie-pmi"),
		});
		const result = buildCanonicalRecall({
			candidates: [firstSeen, secondSeen],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});

		expect(result.items).toHaveLength(1);
		expect(result.items[0].memory.id).toBe("mem-tie-first");
	});

	it("withholds candidates from a different room under the disabled cross-room gate", () => {
		const otherRoomId = "55555555-5555-5555-5555-555555555555" as UUID;
		const sameRoom = makeMemory({
			id: "mem-same" as UUID,
			metadata: discordMeta("pmi-same"),
		});
		const otherRoom = makeMemory({
			id: "mem-other" as UUID,
			roomId: otherRoomId,
			metadata: discordMeta("pmi-other"),
		});
		const result = buildCanonicalRecall({
			candidates: [sameRoom, otherRoom],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});

		expect(result.items.map((item) => item.memory.id)).toEqual(["mem-same"]);
		expect(result.withheld).toHaveLength(1);
		expect(result.withheld[0].code).toBe("cross_room_denied");
		expect(result.withheld[0].reason).toContain("cross-room recall is disabled");
	});

	it("withholds owner-private candidates from a non-owner but admits the owner", () => {
		const privateMemory = makeMemory({
			id: "mem-owner-private" as UUID,
			metadata: { ...discordMeta("pmi-private"), scope: "owner-private" },
		});

		const asUser = buildCanonicalRecall({
			candidates: [privateMemory],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});
		expect(asUser.items).toHaveLength(0);
		expect(asUser.withheld).toHaveLength(1);
		expect(asUser.withheld[0].code).toBe("scope_denied");

		const asOwner = buildCanonicalRecall({
			candidates: [privateMemory],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, isOwner: true },
			destinationRoomId: ROOM_ID,
		});
		expect(asOwner.items).toHaveLength(1);
		expect(asOwner.withheld).toHaveLength(0);
	});

	it("aggregates repeated deny codes into one identifier-free withheld entry", () => {
		const missingAccount = makeMemory({
			id: "mem-no-acct" as UUID,
			metadata: {
				provider: "discord",
				platformMessageId: "p-1",
				scope: "shared",
			},
		});
		const badTimestamp = makeMemory({
			id: "mem-bad-ts" as UUID,
			createdAt: -7,
			metadata: discordMeta("p-2"),
		});
		const valid = makeMemory({
			id: "mem-valid" as UUID,
			metadata: discordMeta("p-ok"),
		});

		const result = buildCanonicalRecall({
			candidates: [missingAccount, badTimestamp, valid],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});

		expect(result.items.map((item) => item.memory.id)).toEqual(["mem-valid"]);
		expect(result.withheld).toHaveLength(1);
		expect(result.withheld[0].code).toBe("invalid_provenance");
		expect(result.withheld[0].reason).not.toContain("acc-1");
		expect(result.withheld[0].reason).not.toContain("p-1");
		expect(result.withheld[0].reason).not.toContain("p-2");
	});

	it("returns an empty result for an empty candidate set", () => {
		const result = buildCanonicalRecall({
			candidates: [],
			agentId: AGENT_ID,
			requester: { requesterEntityId: USER_ID, role: "USER" },
			destinationRoomId: ROOM_ID,
		});

		expect(result.items).toEqual([]);
		expect(result.withheld).toEqual([]);
	});
});

describe("searchCanonicalConversationMemories fail-closed delivery binding", () => {
	it("returns unavailable without querying the adapter when the delivery turn is not runtime-bound", async () => {
		const { searchCanonicalConversationMemories } = await import(
			"./provenance-envelope.js"
		);
		let searchCalls = 0;
		const runtime = {
			agentId: AGENT_ID,
			searchMemories: async () => {
				searchCalls += 1;
				return [];
			},
		} as unknown as Parameters<
			typeof searchCanonicalConversationMemories
		>[0]["runtime"];

		const result = await searchCanonicalConversationMemories({
			runtime,
			embedding: [0.1, 0.2],
			count: 5,
			deliveryMessage: makeMemory(),
		});

		expect(result).toEqual({
			items: [],
			withheld: [],
			availability: "unavailable",
			candidateWindowComplete: false,
		});
		expect(searchCalls).toBe(0);
	});
});
