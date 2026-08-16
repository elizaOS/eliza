/**
 * Pins Ship 17 stateCache cross-room leak (RC-3):
 * - composeState caches State under message.id alone, only audienceCacheKey checked
 * - Same UUID in different rooms reuses provider snapshot → cross-tenant leak
 * Fix: store __roomId in cached State.data and validate __roomId === message.roomId
 * Sibling correct: providerExecutionsInFlight composite key `${id}\x00${provider}\x00${audience}` at 5052 and WeakMap publicProviderStateByMessage at 1259
 */

import { describe, expect, it } from "vitest";

const emptyObj = {} as never;

function oldGetCachedState(
	cachedCandidate: Record<string, unknown> | typeof emptyObj,
	audienceCacheKey: string,
): Record<string, unknown> | typeof emptyObj {
	// old: only audience checked
	if (cachedCandidate === emptyObj) return emptyObj;
	const data = (cachedCandidate as { data: Record<string, unknown> }).data;
	return data.__trustedDeliveryAudienceCacheKey === audienceCacheKey
		? (cachedCandidate as Record<string, unknown>)
		: emptyObj;
}

function fixedGetCachedState(
	cachedCandidate: Record<string, unknown> | typeof emptyObj,
	audienceCacheKey: string,
	messageRoomId: string,
): Record<string, unknown> | typeof emptyObj {
	if (cachedCandidate === emptyObj) return emptyObj;
	const data = (cachedCandidate as { data: Record<string, unknown> }).data;
	return data.__trustedDeliveryAudienceCacheKey === audienceCacheKey &&
		(data as Record<string, unknown>).__roomId === messageRoomId
		? (cachedCandidate as Record<string, unknown>)
		: emptyObj;
}

describe("stateCache room isolation (ship 17) — RC-3", () => {
	it("old cache leaks across rooms: same id different roomId hits vs fixed miss", () => {
		const audience = "aud:owner:123";
		const msgA = { id: "msg-1", roomId: "room-A", content: { text: "hi" } };
		const msgB = { id: "msg-1", roomId: "room-B", content: { text: "hi" } };

		// Simulate cached State for room-A
		const cachedForA = {
			data: {
				__trustedDeliveryAudienceCacheKey: audience,
				__roomId: "room-A",
				providers: { RECENT_MESSAGES: "room-A history" },
			},
			text: "room-A history",
		} as unknown as Record<string, unknown>;

		// Old: same id in room-B incorrectly hits (no roomId check)
		const oldHitForB = oldGetCachedState(cachedForA as never, audience);
		expect(oldHitForB).not.toBe(emptyObj); // BUG: leak

		// Fixed: room-B correctly misses
		const fixedMissForB = fixedGetCachedState(
			cachedForA as never,
			audience,
			msgB.roomId,
		);
		expect(fixedMissForB).toBe(emptyObj);

		// Fixed: room-A correctly hits
		const fixedHitForA = fixedGetCachedState(
			cachedForA as never,
			audience,
			msgA.roomId,
		);
		expect(fixedHitForA).toBe(cachedForA as never);

		// Audience mismatch still misses even with same room
		const audience2 = "aud:owner:999";
		const fixedAudienceMiss = fixedGetCachedState(
			cachedForA as never,
			audience2,
			msgA.roomId,
		);
		expect(fixedAudienceMiss).toBe(emptyObj);
	});

	it("legacy cached entry without __roomId correctly misses for any room", () => {
		const audience = "aud:owner:123";
		const cachedLegacy = {
			data: {
				__trustedDeliveryAudienceCacheKey: audience,
				// no __roomId
				providers: { FACTS: "old" },
			},
		} as unknown as Record<string, unknown>;
		// Fixed should miss because undefined !== "room-A"
		expect(fixedGetCachedState(cachedLegacy as never, audience, "room-A")).toBe(
			emptyObj,
		);
		expect(fixedGetCachedState(cachedLegacy as never, audience, "room-B")).toBe(
			emptyObj,
		);
	});

	it("ship17 sibling proof: runtime uses __roomId check and stores __roomId", async () => {
		const fs = await import("node:fs");
		const src = fs.readFileSync("packages/core/src/runtime.ts", "utf8");
		expect(src).toContain("__roomId");
		expect(src).toContain(
			"(cachedCandidate.data as Record<string, unknown>).__roomId ===",
		);
		expect(src).toContain("__roomId: message.roomId");
		// old single-check pattern without roomId should not remain alone
		// ensure the composite check exists
		expect(src).toContain("audienceCacheKey &&");
	});
});
