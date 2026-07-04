/**
 * Failure-path coverage for CommunityInvestorService.getCurrentPrice. A price
 * lookup failure previously returned a fabricated 0, which reads as a -100%
 * return in P&L/trust scoring. It must now surface (reportError) and rethrow
 * (error-policy sweep, #12748).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CommunityInvestorService } from "./service";

function createRuntime(reportError: ReturnType<typeof vi.fn>): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		getSetting: (key: string) =>
			key === "BIRDEYE_API_KEY" ? "test-birdeye-key" : undefined,
		getCache: async () => undefined,
		setCache: async () => undefined,
		useModel: async () => [0.1, 0.2, 0.3],
		searchMemories: async () => [],
		ensureWorldExists: async () => undefined,
		ensureRoomExists: async () => undefined,
		registerTaskWorker: () => undefined,
		getTasks: async () => [],
		createTask: async () => undefined,
		reportError,
	} as unknown as IAgentRuntime;
}

describe("CommunityInvestorService.getCurrentPrice", () => {
	it("surfaces and rethrows a price fetch failure instead of returning 0", async () => {
		const reportError = vi.fn();
		const service = new CommunityInvestorService(createRuntime(reportError));

		(
			service as unknown as {
				birdeyeClient: { fetchPrice: () => Promise<number> };
			}
		).birdeyeClient = {
			fetchPrice: vi.fn().mockRejectedValue(new Error("birdeye 503")),
		};

		await expect(
			service.getCurrentPrice(
				"solana",
				"So11111111111111111111111111111111111111112",
			),
		).rejects.toThrow("birdeye 503");
		expect(reportError).toHaveBeenCalledWith(
			"CommunityInvestorService.getCurrentPrice",
			expect.any(Error),
			expect.objectContaining({ chain: "solana" }),
		);
	});
});
