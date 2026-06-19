import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SupportedChain } from "../types";
import {
	PriceEnrichmentService,
	type TradingCall,
} from "./priceEnrichmentService";

function createRuntime(): IAgentRuntime {
	return {
		getSetting: (key: string) =>
			key === "BIRDEYE_API_KEY" || key === "DEXSCREENER_API_KEY"
				? "test-key"
				: undefined,
		getCache: async () => undefined,
		setCache: async () => undefined,
	} as unknown as IAgentRuntime;
}

function tradingCall(overrides: Partial<TradingCall>): TradingCall {
	return {
		callId: "call-1",
		originalMessageId: "message-1",
		userId: "user-1",
		username: "alice",
		timestamp: Date.now(),
		content: "bullish",
		chain: "solana",
		sentiment: "positive",
		conviction: "HIGH",
		llmReasoning: "test",
		certainty: "high",
		fileSource: "test",
		...overrides,
	};
}

describe("PriceEnrichmentService", () => {
	it("resolves Solana token symbols through DexScreener search", async () => {
		const service = new PriceEnrichmentService(createRuntime());
		const search = vi.fn().mockResolvedValue({
			pairs: [
				{
					chainId: "solana",
					baseToken: {
						address: "So11111111111111111111111111111111111111112",
						symbol: "SOLX",
						name: "Solana X",
					},
					liquidity: { usd: 1_000_000 },
				},
			],
		});
		(
			service as unknown as { dexscreenerClient: { search: typeof search } }
		).dexscreenerClient = { search };

		const resolved = await service.resolveToken(
			tradingCall({ tokenMentioned: "SOLX" }),
		);

		expect(search).toHaveBeenCalledWith("SOLX", { expires: "5m" });
		expect(resolved).toEqual({
			address: "So11111111111111111111111111111111111111112",
			symbol: "SOLX",
			name: "Solana X",
			chain: SupportedChain.SOLANA,
		});
	});
});
