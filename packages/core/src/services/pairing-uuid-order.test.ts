/**
 * The unpaged pairing fallback slices newest-first. A same-millisecond tie
 * must keep the higher UUID, including when the ids differ only by case.
 */
import { describe, expect, it } from "vitest";
import type { UUID } from "../types/primitives.js";
import type { IAgentRuntime } from "../types/runtime";
import { PairingService } from "./pairing";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB" as UUID;

describe("pairing page UUID ties", () => {
	it("keeps the higher UUID when two requests share a millisecond", async () => {
		const createdAt = new Date();
		const runtime = {
			agentId: AGENT,
			getPairingRequests: async () => [
				{
					channel: "telegram",
					agentId: AGENT,
					requests: [
						{
							id: LOWER,
							channel: "telegram",
							senderId: "lower",
							code: "AAAAAAAA",
							createdAt,
							lastSeenAt: createdAt,
							agentId: AGENT,
						},
						{
							id: UPPER,
							channel: "telegram",
							senderId: "upper",
							code: "BBBBBBBB",
							createdAt,
							lastSeenAt: createdAt,
							agentId: AGENT,
						},
					],
				},
			],
		} as unknown as IAgentRuntime;

		const page = await new PairingService(runtime).listPendingRequestsPage(
			"telegram",
			{ limit: 1 },
		);

		expect(page.items.map((request) => request.id)).toEqual([UPPER]);
	});
});
