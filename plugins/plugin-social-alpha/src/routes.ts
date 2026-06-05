import type {
	IAgentRuntime,
	Route,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CommunityInvestorService } from "./service";
import { ServiceType } from "./types";

type JsonResponseBody = Record<string, unknown> | unknown[];
type NodeStyleRouteResponse = RouteResponse & {
	writeHead(status: number, headers: Record<string, string>): void;
	end(chunk?: string): RouteResponse;
};

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function nodeResponse(res: RouteResponse): NodeStyleRouteResponse {
	return res as NodeStyleRouteResponse;
}

// Helper to send success response
function sendSuccess(res: RouteResponse, data: JsonResponseBody, status = 200) {
	const nodeRes = nodeResponse(res);
	nodeRes.writeHead(status, { "Content-Type": "application/json" });
	nodeRes.end(JSON.stringify({ success: true, data }));
}

// Helper to send error response
function sendError(
	res: RouteResponse,
	status: number,
	code: string,
	message: string,
	details?: string,
) {
	const nodeRes = nodeResponse(res);
	nodeRes.writeHead(status, { "Content-Type": "application/json" });
	nodeRes.end(
		JSON.stringify({ success: false, error: { code, message, details } }),
	);
}

async function getLeaderboardDataHandler(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
) {
	const service = runtime.getService<CommunityInvestorService>(
		ServiceType.COMMUNITY_INVESTOR,
	);
	if (!service) {
		return sendError(
			res,
			500,
			"SERVICE_NOT_FOUND",
			"CommunityInvestorService not found",
		);
	}
	try {
		const leaderboardData = await service.getLeaderboardData(runtime);
		// Return the leaderboard data directly as an array, not wrapped in an object
		sendSuccess(res, leaderboardData);
	} catch (error: unknown) {
		logger.error(
			`[API /leaderboard] Error fetching leaderboard data: ${errorMessage(error)}`,
		);
		sendError(
			res,
			500,
			"LEADERBOARD_ERROR",
			"Failed to fetch leaderboard data",
			errorMessage(error),
		);
	}
}

export const communityInvestorRoutes: Route[] = [
	{
		type: "GET",
		path: "/leaderboard", // This will be /api/agents/:agentId/plugins/community-investor/leaderboard
		handler: getLeaderboardDataHandler,
	},
];
