/**
 * Unit tests for SEARCH_CHANNEL_TOPICS action handler and validation logic.
 * Exercises query resolution, service availability checks, matching formatting,
 * and scope reporting.
 */
import { describe, expect, it, vi } from "vitest";
import { channelTopicSearchAction } from "../features/basic-capabilities/actions/channel-topic-search.ts";
import type { IAgentRuntime, Memory } from "../types/index.ts";

describe("channel-topic-search action", () => {
	describe("validate", () => {
		it("returns false when channel_topics service is not registered", async () => {
			const runtime = {
				getService: vi.fn().mockReturnValue(null),
			} as unknown as IAgentRuntime;

			const valid = await channelTopicSearchAction.validate(
				runtime,
				{} as Memory,
			);
			expect(valid).toBe(false);
		});

		it("returns true when channel_topics service with searchTopics is registered", async () => {
			const runtime = {
				getService: vi.fn().mockReturnValue({
					searchTopics: vi.fn(),
				}),
			} as unknown as IAgentRuntime;

			const valid = await channelTopicSearchAction.validate(
				runtime,
				{} as Memory,
			);
			expect(valid).toBe(true);
		});
	});

	describe("handler", () => {
		it("returns failure when channel_topics service is unavailable", async () => {
			const runtime = {
				getService: vi.fn().mockReturnValue(null),
			} as unknown as IAgentRuntime;

			const message = {
				content: { text: "search query" },
			} as unknown as Memory;
			const result = await channelTopicSearchAction.handler(runtime, message);

			expect(result.success).toBe(false);
			expect(result.text).toBe("Channel topic search is unavailable.");
		});

		it("returns failure when search query is empty", async () => {
			const runtime = {
				getService: vi.fn().mockReturnValue({
					searchTopics: vi.fn(),
				}),
			} as unknown as IAgentRuntime;

			const message = { content: { text: "" } } as unknown as Memory;
			const result = await channelTopicSearchAction.handler(runtime, message);

			expect(result.success).toBe(false);
			expect(result.text).toBe("Provide a topic to search for.");
		});

		it("searches topics using explicit parameter and returns formatted hits", async () => {
			const searchTopicsMock = vi
				.fn()
				.mockReturnValue([
					{ roomId: "room-crypto", matchedTopics: ["solana", "trading"] },
				]);
			const getTopicsForAllRoomsMock = vi.fn().mockReturnValue({
				"room-crypto": ["solana", "trading"],
				"room-general": ["chat"],
			});

			const runtime = {
				getService: vi.fn().mockReturnValue({
					searchTopics: searchTopicsMock,
					getTopicsForAllRooms: getTopicsForAllRoomsMock,
				}),
			} as unknown as IAgentRuntime;

			const message = {
				content: { text: "fallback text" },
			} as unknown as Memory;
			const options = { parameters: { query: "solana" } };
			const result = await channelTopicSearchAction.handler(
				runtime,
				message,
				undefined,
				options,
			);

			expect(searchTopicsMock).toHaveBeenCalledWith("solana");
			expect(result.success).toBe(true);
			expect(result.values?.matchCount).toBe(1);
			expect(result.text).toContain("Channels discussing");
			expect(result.text).toContain("room-crypto: solana, trading");
		});

		it("formats cleanly when zero hits are found", async () => {
			const runtime = {
				getService: vi.fn().mockReturnValue({
					searchTopics: vi.fn().mockReturnValue([]),
					getTopicsForAllRooms: vi.fn().mockReturnValue({}),
				}),
			} as unknown as IAgentRuntime;

			const message = {
				content: { text: "quantum-physics" },
			} as unknown as Memory;
			const result = await channelTopicSearchAction.handler(runtime, message);

			expect(result.success).toBe(true);
			expect(result.values?.matchCount).toBe(0);
			expect(result.text).toContain(
				"No channels in 0 active or hydrated room(s) in memory",
			);
		});
	});
});
