import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { communityInvestorRoutes } from "./routes";
import { ServiceType } from "./types";

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
		agentId: "agent-1",
		getService: vi.fn((name: string) =>
			name === ServiceType.COMMUNITY_INVESTOR ? service : null,
		),
	} as unknown as IAgentRuntime;
}

describe("communityInvestorRoutes", () => {
	it("returns leaderboard data and service failures with the route envelope", async () => {
		const leaderboardRoute = communityInvestorRoutes.find(
			(route) => route.path === "/api/social-alpha/leaderboard",
		);
		const service = {
			getLeaderboardData: vi.fn(async () => [
				{ userId: "u1", rank: 1, score: 99 },
			]),
		};
		const response = makeResponse();

		await leaderboardRoute?.handler?.(
			{} as RouteRequest,
			response,
			runtime(service),
		);

		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual({
			success: true,
			data: [{ userId: "u1", rank: 1, score: 99 }],
		});

		const missingServiceResponse = makeResponse();
		await leaderboardRoute?.handler?.(
			{} as RouteRequest,
			missingServiceResponse,
			runtime(null),
		);
		expect(missingServiceResponse.statusCode).toBe(500);
		expect(JSON.parse(missingServiceResponse.body)).toEqual({
			success: false,
			error: {
				code: "SERVICE_NOT_FOUND",
				message: "CommunityInvestorService not found",
			},
		});
	});
});
