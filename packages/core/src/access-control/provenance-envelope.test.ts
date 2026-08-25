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

describe("deriveCanonicalProvenance additive branches", () => {
	it("falls back to content and base sources while reading nested identities", () => {
		const fromContent = deriveCanonicalProvenance(
			makeMemory({
				content: { text: "from content", source: "telegram" },
				metadata: {
					accountId: "bot-1",
					platformMessageId: "41",
					scope: "room",
					telegram: { id: 12345, username: "telegram-user" },
				},
			}),
			AGENT_ID,
		);

		expect(fromContent).toMatchObject({
			valid: true,
			provenance: {
				source: "telegram",
				rawSource: "telegram",
				senderPlatformId: "12345",
				senderDisplayName: "telegram-user",
			},
		});

		const fromBase = deriveCanonicalProvenance(
			makeMemory({
				metadata: {
					accountId: "bot-2",
					platformMessageId: "42",
					base: { source: "telegram", scope: "shared" },
				},
			}),
			AGENT_ID,
		);

		expect(fromBase).toMatchObject({
			valid: true,
			provenance: {
				source: "telegram",
				rawSource: "telegram",
				scope: "shared",
			},
		});
	});

	it("rejects non-positive and non-finite timestamps", () => {
		for (const createdAt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const result = deriveCanonicalProvenance(
				makeMemory({ createdAt }),
				AGENT_ID,
			);
			expect(result).toEqual({
				valid: false,
				code: "invalid_provenance",
				source: "discord",
				reason: "stored memory is missing a valid timestamp",
			});
		}
	});

	it("accepts every declared scope and rejects an unknown scope", () => {
		for (const scope of [
			"shared",
			"private",
			"room",
			"global",
			"owner-private",
			"user-private",
			"agent-private",
		] as const) {
			const result = deriveCanonicalProvenance(
				makeMemory({
					metadata: {
						provider: "discord",
						accountId: "acc-1",
						platformMessageId: `scope-${scope}`,
						scope,
					},
				}),
				AGENT_ID,
			);
			expect(result).toMatchObject({ valid: true, provenance: { scope } });
		}

		const unknown = deriveCanonicalProvenance(
			makeMemory({
				metadata: {
					provider: "discord",
					accountId: "acc-1",
					platformMessageId: "unknown-scope",
					scope: "team-private",
				},
			}),
			AGENT_ID,
		);
		expect(unknown).toMatchObject({
			valid: false,
			code: "invalid_provenance",
			reason: "stored memory is missing a valid scope",
		});
	});
});

function recallMemory(
	id: string,
	createdAt: number,
	platformMessageId: string,
	overrides: Partial<Memory> = {},
): Memory {
	return makeMemory({
		id: id as UUID,
		createdAt,
		metadata: {
			provider: "discord",
			accountId: "acc-1",
			platformMessageId,
			scope: "shared",
			discord: { userId: "discord-user-1" },
		},
		...overrides,
	});
}

describe("buildCanonicalRecall additive branches", () => {
	const requester = { requesterEntityId: USER_ID, role: "USER" as const };

	it("returns empty arrays for an empty candidate queue", () => {
		const result = buildCanonicalRecall({
			candidates: [],
			agentId: AGENT_ID,
			requester,
			destinationRoomId: ROOM_ID,
		});

		expect(result).toEqual({ items: [], withheld: [] });
	});

	it("sorts records chronologically and keeps the first encounter on a timestamp tie", () => {
		const later = recallMemory("later", 30, "later");
		const firstTie = recallMemory("first-tie", 20, "tie");
		const earlier = recallMemory("earlier", 10, "earlier");
		const secondTie = recallMemory("second-tie", 20, "tie", {
			content: { text: "second encounter" },
		});

		const result = buildCanonicalRecall({
			candidates: [later, firstTie, earlier, secondTie],
			agentId: AGENT_ID,
			requester,
			destinationRoomId: ROOM_ID,
		});

		expect(result.items.map((item) => item.memory.id)).toEqual([
			"earlier",
			"first-tie",
			"later",
		]);
		expect(result.withheld).toEqual([]);
	});

	it("aggregates denial codes without leaking withheld identifiers", () => {
		const invalidOne = recallMemory("invalid-one", 1, "secret-message-one", {
			metadata: {
				provider: "discord",
				platformMessageId: "secret-message-one",
				scope: "shared",
			},
		});
		const invalidTwo = recallMemory("invalid-two", 2, "secret-message-two", {
			metadata: {
				provider: "discord",
				platformMessageId: "secret-message-two",
				scope: "shared",
			},
		});
		const privateOther = recallMemory("private-other", 3, "private-record", {
			entityId: "33333333-3333-3333-3333-333333333333" as UUID,
			metadata: {
				provider: "discord",
				accountId: "secret-account",
				platformMessageId: "private-record",
				scope: "user-private",
			},
		});
		const crossRoom = recallMemory("cross-room", 4, "cross-room-record", {
			roomId: "44444444-4444-4444-4444-444444444444" as UUID,
		});

		const result = buildCanonicalRecall({
			candidates: [invalidOne, invalidTwo, privateOther, crossRoom],
			agentId: AGENT_ID,
			requester,
			destinationRoomId: ROOM_ID,
		});

		expect(result.items).toEqual([]);
		expect(result.withheld.map((item) => item.code)).toEqual([
			"invalid_provenance",
			"scope_denied",
			"cross_room_denied",
		]);
		expect(result.withheld).toHaveLength(3);
		const serialized = JSON.stringify(result.withheld);
		expect(serialized).not.toContain("secret-message");
		expect(serialized).not.toContain("secret-account");
	});
});
