/**
 * Failure-path coverage for the market-data clients: a transport failure must
 * surface, and must never be laundered into an "empty result" that reads as a
 * token with no pairs (error-policy sweep, #12748).
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DexscreenerClient } from "./clients";

function createRuntime(): IAgentRuntime {
	return {
		getSetting: () => undefined,
		getCache: async () => undefined,
		setCache: async () => undefined,
	} as unknown as IAgentRuntime;
}

describe("DexscreenerClient.search", () => {
	it("propagates a transport failure instead of returning empty pairs", async () => {
		const client = new DexscreenerClient(createRuntime());
		const request = vi.fn().mockRejectedValue(new Error("network down"));
		(client as unknown as { request: typeof request }).request = request;

		await expect(client.search("So1111")).rejects.toThrow("network down");
	});

	it("returns a genuine empty result when the API responds with no pairs", async () => {
		const client = new DexscreenerClient(createRuntime());
		const request = vi.fn().mockResolvedValue({ pairs: undefined });
		(client as unknown as { request: typeof request }).request = request;

		const result = await client.search("So1111");
		expect(result).toEqual({ schemaVersion: "1.0.0", pairs: [] });
	});
});
