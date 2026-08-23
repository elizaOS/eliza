/**
 * Exercises the plugin search handler through its real implementation: the
 * unavailable-service and empty-query failures, the empty-result completion
 * shape, ranked rendering of registry hits with optional fields and zero
 * scores, and neutral-reference fallbacks for unshaped queries.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import { runSearch } from "./search.ts";

interface RegistryResult {
	name: string;
	score?: number;
	description?: string;
	tags?: string[];
	version?: string;
}

function createRuntime({
	available = true,
	results = [],
	queries,
}: {
	available?: boolean;
	results?: RegistryResult[];
	queries?: string[];
} = {}): IAgentRuntime {
	const service = available
		? {
				searchRegistry: async (query: string) => {
					queries?.push(query);
					return results;
				},
			}
		: null;

	return {
		getService: (name: string) => (name === "plugin_manager" ? service : null),
	} as unknown as IAgentRuntime;
}

describe("runSearch", () => {
	it("returns a structured failure through the callback when the service is unavailable", async () => {
		const replies: unknown[] = [];

		const result = await runSearch({
			runtime: createRuntime({ available: false }),
			query: "blockchain",
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		expect(result).toEqual({
			success: false,
			text: "Plugin manager service not available",
		});
		expect(replies).toEqual([{ text: "Plugin manager service not available" }]);
	});

	it("rejects an empty query before touching the registry", async () => {
		const replies: unknown[] = [];
		const queries: string[] = [];

		const result = await runSearch({
			runtime: createRuntime({ queries }),
			query: "",
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		expect(result).toEqual({
			success: false,
			text: 'Specify a search query (e.g. "plugins for blockchain transactions").',
		});
		expect(replies).toEqual([
			{
				text: 'Specify a search query (e.g. "plugins for blockchain transactions").',
			},
		]);
		expect(queries).toEqual([]);
	});

	it("reports an empty registry result as the complete verified answer", async () => {
		const replies: unknown[] = [];
		const queries: string[] = [];

		const result = await runSearch({
			runtime: createRuntime({ results: [], queries }),
			query: "voice agents",
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		expect(queries).toEqual(["voice agents"]);
		expect(replies).toEqual([
			{
				text: 'No plugins found matching "voice agents". Try keywords like database, twitter, solana, voice.',
			},
		]);
		expect(result).toEqual({
			success: true,
			text: 'No plugins found matching "voice agents". Try keywords like database, twitter, solana, voice.',
			userFacingText:
				'No plugins found matching "voice agents". Try keywords like database, twitter, solana, voice.',
			verifiedUserFacing: true,
			turnComplete: true,
			values: { mode: "search", count: 0 },
		});
		expect("data" in result).toBe(false);
	});

	it("renders every registry hit in service order with scores, descriptions, tags, and versions", async () => {
		const replies: unknown[] = [];
		const results: RegistryResult[] = [
			{
				name: "@elizaos/plugin-web3",
				score: 0.924,
				description: "Ethereum wallet helpers",
				tags: ["ethereum", "wallet"],
				version: "1.4.2",
			},
			{ name: "@elizaos/plugin-solana", score: 0 },
			{
				name: "@elizaos/plugin-voice",
				score: 0.5,
				description: "Speech utilities",
				tags: ["a", "b", "c", "d", "e", "f"],
				version: "0.9.0",
			},
		];

		const result = await runSearch({
			runtime: createRuntime({ results }),
			query: "blockchain",
			callback: async (content) => {
				replies.push(content);
				return [];
			},
		});

		const expectedText = [
			'Found 3 plugin(s) matching "blockchain":',
			"",
			"1. @elizaos/plugin-web3 (match: 92%)",
			"   Ethereum wallet helpers",
			"   tags: ethereum, wallet",
			"   version: 1.4.2",
			"2. @elizaos/plugin-solana",
			"3. @elizaos/plugin-voice (match: 50%)",
			"   Speech utilities",
			"   tags: a, b, c, d, e",
			"   version: 0.9.0",
		].join("\n");

		expect(result.text).toBe(expectedText);
		expect(result.userFacingText).toBe(expectedText);
		expect(replies).toEqual([{ text: expectedText }]);
		expect(result.values).toEqual({
			mode: "search",
			count: 3,
			query: "blockchain",
		});
		expect(result.data).toEqual({ results });
	});

	it("uses the neutral reference noun for unshaped queries while collapsing them in metadata", async () => {
		const result = await runSearch({
			runtime: createRuntime({
				results: [{ name: "@elizaos/plugin-solana", score: 0.5 }],
			}),
			query: "solana\ntransfer indexer",
		});

		expect(result.text).toBe(
			[
				"Found 1 plugin(s) matching that request:",
				"",
				"1. @elizaos/plugin-solana (match: 50%)",
			].join("\n"),
		);
		expect(result.values).toEqual({
			mode: "search",
			count: 1,
			query: "solana transfer indexer",
		});
	});
});
