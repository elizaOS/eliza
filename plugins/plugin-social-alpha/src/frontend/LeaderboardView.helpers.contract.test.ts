// Contract tests for the leaderboard client parser (fetchLeaderboardData,
// parseRecommendationRow, hasWalletConfigured) against the REAL route output.
//
// The audit gap this closes: routes.test.ts asserts the {success,data} envelope
// but never runs the client parser over it, so the parser was unvalidated
// against the real API shape. Here we invoke the actual communityInvestorRoutes
// handler from ../routes against a fake runtime whose service returns a
// realistic ranked LeaderboardEntry[] (mirroring CommunityInvestorService.
// getLeaderboardData's output: userId/username/trustScore/recommendations[]/
// rank), capture the exact JSON the handler writes (JSON.stringify({success:
// true,data})), and feed that parsed envelope to the REAL fetchLeaderboardData
// by mocking client.fetch to return it. This proves the parser is contract-
// compatible with sendSuccess() in src/routes.ts.

import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { communityInvestorRoutes } from "../routes";
import type { LeaderboardEntry } from "../types";
import { Conviction, ServiceType, SupportedChain } from "../types";

// ---------------------------------------------------------------------------
// Controllable @elizaos/ui/api client mock (the only runtime dep of the helpers).
// ---------------------------------------------------------------------------
const apiClient = vi.hoisted(() => ({
	fetch: vi.fn(),
	getWalletAddresses: vi.fn(),
}));

vi.mock("@elizaos/ui/api", () => ({ client: apiClient }));

import {
	fetchLeaderboardData,
	hasWalletConfigured,
} from "./LeaderboardView.helpers";

// ---------------------------------------------------------------------------
// Node-style RouteResponse double that records what the handler writes.
// ---------------------------------------------------------------------------
function makeResponse() {
	const response = {
		statusCode: 0,
		headers: {} as Record<string, string>,
		body: "",
		writeHead: vi.fn((status: number, headers: Record<string, string>) => {
			response.statusCode = status;
			response.headers = { ...response.headers, ...headers };
		}),
		end: vi.fn((chunk?: string) => {
			response.body = chunk ?? "";
			return response;
		}),
		status: vi.fn(() => response),
		json: vi.fn(() => response),
		send: vi.fn(() => response),
	};
	return response as typeof response & RouteResponse;
}

function runtime(service: unknown): IAgentRuntime {
	return {
		agentId: "agent-contract",
		getService: vi.fn((name: string) =>
			name === ServiceType.COMMUNITY_INVESTOR ? service : null,
		),
	} as unknown as IAgentRuntime;
}

/** Realistic service output: unsorted ranks, a row missing username/trustScore,
 *  and recommendations with string-typed timestamps + a missing tokenAddress,
 *  to exercise every coercion in parseRecommendationRow. */
function serviceLeaderboard(): unknown[] {
	return [
		{
			userId: "low-1",
			username: "weak-caller",
			trustScore: 3.1,
			rank: 99, // wrong on purpose — parser must re-rank
			recommendations: [],
		},
		{
			userId: "top-1",
			username: "alpha-chad",
			trustScore: 88.4,
			rank: 1,
			recommendations: [
				{
					id: "rec-1",
					userId: "top-1",
					messageId: "m-1",
					// string timestamp -> parser must Number() it
					timestamp: "1700000000000",
					tokenTicker: "BONK",
					tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
					chain: SupportedChain.SOLANA,
					recommendationType: "BUY",
					conviction: Conviction.HIGH,
					rawMessageQuote: "bonk to the moon",
					priceAtRecommendation: 0.0000123,
					metrics: {
						potentialProfitPercent: 210.5,
						isScamOrRug: false,
						evaluationTimestamp: 1700500000000,
						notes: "ran 3x",
					},
				},
				{
					id: "rec-2",
					userId: "top-1",
					messageId: "m-2",
					timestamp: 1700100000000,
					// no tokenAddress -> parser must coerce to ""
					chain: SupportedChain.ETHEREUM,
					recommendationType: "SELL",
					conviction: Conviction.MEDIUM,
					rawMessageQuote: "exit now",
				},
			],
		},
		{
			// missing username + trustScore -> parser must coerce to undefined / 0
			userId: "mid-1",
			rank: 2,
			recommendations: [],
		},
	];
}

/** Run the real route handler over a stub service and return the parsed
 *  {success,data} envelope exactly as the client would receive it. */
async function captureRouteEnvelope(leaderboard: unknown[]): Promise<unknown> {
	const route = communityInvestorRoutes.find(
		(r) => r.path === "/api/social-alpha/leaderboard",
	);
	const service = {
		getLeaderboardData: vi.fn(async () => leaderboard),
	};
	const res = makeResponse();
	await route?.handler?.({} as RouteRequest, res, runtime(service));
	expect(res.statusCode).toBe(200);
	return JSON.parse(res.body);
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("fetchLeaderboardData over the real route envelope", () => {
	it("parses, re-sorts by trustScore desc, and reassigns rank 1..n", async () => {
		const envelope = await captureRouteEnvelope(serviceLeaderboard());
		// Sanity: the handler produced the documented sendSuccess() shape.
		expect((envelope as { success: boolean }).success).toBe(true);

		apiClient.fetch.mockResolvedValueOnce(envelope);
		const result: LeaderboardEntry[] = await fetchLeaderboardData();

		expect(apiClient.fetch).toHaveBeenCalledWith(
			"/api/social-alpha/leaderboard",
		);

		// Re-sorted by trustScore desc regardless of the route's rank field.
		expect(result.map((r) => r.userId)).toEqual(["top-1", "low-1", "mid-1"]);
		// Rank reassigned by sorted index.
		expect(result.map((r) => r.rank)).toEqual([1, 2, 3]);

		// Row missing username/trustScore is coerced.
		const mid = result[2];
		expect(mid.username).toBeUndefined();
		expect(mid.trustScore).toBe(0);
	});

	it("coerces each recommendation field (timestamp Number, missing tokenAddress, metrics passthrough)", async () => {
		const envelope = await captureRouteEnvelope(serviceLeaderboard());
		apiClient.fetch.mockResolvedValueOnce(envelope);
		const result = await fetchLeaderboardData();

		// top-1 has the highest trustScore (88.4) so it sorts to index 0.
		const top = result[0];
		expect(top.userId).toBe("top-1");
		const [rec1, rec2] = top.recommendations;

		// String timestamp -> number.
		expect(rec1.timestamp).toBe(1_700_000_000_000);
		expect(typeof rec1.timestamp).toBe("number");
		expect(rec1.tokenTicker).toBe("BONK");
		expect(rec1.priceAtRecommendation).toBe(0.0000123);
		// Metrics pass through untouched.
		expect(rec1.metrics?.potentialProfitPercent).toBe(210.5);
		expect(rec1.metrics?.notes).toBe("ran 3x");

		// Missing tokenAddress -> coerced to "".
		expect(rec2.tokenAddress).toBe("");
		// priceAtRecommendation absent -> undefined (not 0).
		expect(rec2.priceAtRecommendation).toBeUndefined();
		expect(rec2.recommendationType).toBe("SELL");
	});

	it("throws using data.message when the envelope's data is not an array (SERVICE_NOT_FOUND path)", async () => {
		// Real failure envelope produced by the route when the service is missing.
		const route = communityInvestorRoutes.find(
			(r) => r.path === "/api/social-alpha/leaderboard",
		);
		const res = makeResponse();
		await route?.handler?.({} as RouteRequest, res, runtime(null));
		expect(res.statusCode).toBe(500);
		const failEnvelope = JSON.parse(res.body) as {
			success: boolean;
			error: { message: string };
		};
		expect(failEnvelope.success).toBe(false);

		// The parser reads data.message; the failure envelope has no top-level
		// `message`, so it falls back to the default error string.
		apiClient.fetch.mockResolvedValueOnce(failEnvelope);
		await expect(fetchLeaderboardData()).rejects.toThrow(
			/did not include a data array/,
		);
	});

	it("throws with the API-provided message when one is present", async () => {
		apiClient.fetch.mockResolvedValueOnce({
			message: "leaderboard temporarily unavailable",
			data: null,
		});
		await expect(fetchLeaderboardData()).rejects.toThrow(
			"leaderboard temporarily unavailable",
		);
	});
});

describe("hasWalletConfigured", () => {
	it("is true when an EVM address is present", async () => {
		apiClient.getWalletAddresses.mockResolvedValueOnce({
			evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
			solanaAddress: null,
		});
		await expect(hasWalletConfigured()).resolves.toBe(true);
	});

	it("is true when only a Solana address is present", async () => {
		apiClient.getWalletAddresses.mockResolvedValueOnce({
			evmAddress: null,
			solanaAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
		});
		await expect(hasWalletConfigured()).resolves.toBe(true);
	});

	it("is false when no address is configured", async () => {
		apiClient.getWalletAddresses.mockResolvedValueOnce({
			evmAddress: null,
			solanaAddress: null,
		});
		await expect(hasWalletConfigured()).resolves.toBe(false);
	});

	it("is false (catch path) when the wallet lookup throws", async () => {
		apiClient.getWalletAddresses.mockRejectedValueOnce(
			new Error("wallet service down"),
		);
		await expect(hasWalletConfigured()).resolves.toBe(false);
	});
});
