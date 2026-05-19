import fs from "node:fs";
import path from "node:path";
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

async function communityInvestorPanelHandler(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
) {
	const nodeRes = nodeResponse(res);
	try {
		const pluginDistPath = path.dirname(
			new URL(import.meta.url).pathname.replace(/^\/[A-Z]:/, ""),
		);
		const indexPath = path.join(pluginDistPath, "index.html");

		logger.debug(
			`[COMMUNITY INVESTOR PANEL] pluginDistPath: ${pluginDistPath}`,
		);
		logger.debug(`[COMMUNITY INVESTOR PANEL] indexPath: ${indexPath}`);
		logger.debug(
			`[COMMUNITY INVESTOR PANEL] File exists: ${fs.existsSync(indexPath)}`,
		);

		if (fs.existsSync(indexPath)) {
			let html = await fs.promises.readFile(indexPath, "utf8");
			const agentId = runtime.agentId;
			if (agentId) {
				html = html.replace(
					"<head>",
					`<head>\n    <script>window.elizaAgentId = "${agentId}";</script>`,
				);
				logger.debug(`[COMMUNITY INVESTOR PANEL] Injected agentId: ${agentId}`);
			} else {
				logger.warn(
					"[COMMUNITY INVESTOR PANEL] AgentId not available in runtime for injection.",
				);
			}
			logger.debug(
				`[COMMUNITY INVESTOR PANEL] Serving HTML (first 250 chars after potential injection): ${html.substring(0, 250)}`,
			);
			nodeRes.writeHead(200, { "Content-Type": "text/html" });
			nodeRes.end(html);
		} else {
			logger.error(
				`[COMMUNITY INVESTOR PANEL] Frontend index.html not found at ${indexPath}`,
			);
			// Fallback: serve a basic HTML page that loads the JS bundle from the assets folder
			const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Social Alpha Leaderboard</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; background: #0f0f0f; color: #fff; }
        .container { max-width: 1200px; margin: 0 auto; }
        .loading { text-align: center; padding: 40px; color: #666; }
        .error { text-align: center; padding: 40px; color: #ff6b6b; }
    </style>
</head>
<body>
    <div class="container">
        <div id="root">
            <div class="error">
                <h2>Social Alpha Leaderboard</h2>
                <p>Frontend assets not found. Please ensure the frontend is built correctly.</p>
                <p>Run: <code>npm run build</code> in the plugin-marketplace-of-trust directory.</p>
                <p>Looking for: ${indexPath}</p>
            </div>
        </div>
    </div>
</body>
</html>`;
			nodeRes.writeHead(200, { "Content-Type": "text/html" });
			nodeRes.end(html);
		}
	} catch (error: unknown) {
		logger.error(
			`[COMMUNITY INVESTOR PANEL] Error serving leaderboard panel: ${errorMessage(error)}`,
		);
		sendError(
			res,
			500,
			"PANEL_ERROR",
			"Failed to load leaderboard panel",
			errorMessage(error),
		);
	}
}

async function communityInvestorAssetsHandler(
	req: RouteRequest,
	res: RouteResponse,
	_runtime: IAgentRuntime,
) {
	const nodeRes = nodeResponse(res);
	try {
		const requestedAssetPath = req.path ?? "";
		logger.debug(
			`[COMMUNITY INVESTOR ASSET HANDLER] Called with req.path: ${requestedAssetPath}, req.originalUrl: ${req.url ?? ""}`,
		);
		const pluginDistPath = path.dirname(
			new URL(import.meta.url).pathname.replace(/^\/[A-Z]:/, ""),
		);
		// When running from dist/index.js, pluginDistPath is the dist directory itself.
		// Assets are in a subfolder 'assets' within this dist directory.
		const assetsBasePath = path.join(pluginDistPath, "assets");

		const assetsMarker = "/assets/";
		const assetsStartIndex = requestedAssetPath.indexOf(assetsMarker);

		if (assetsStartIndex === -1) {
			return sendError(res, 400, "BAD_REQUEST", "Invalid asset path");
		}
		const assetName = requestedAssetPath.substring(
			assetsStartIndex + assetsMarker.length,
		);
		if (!assetName || assetName.includes("..")) {
			return sendError(
				res,
				400,
				"BAD_REQUEST",
				`Invalid asset name: '${assetName}' from path ${requestedAssetPath}`,
			);
		}

		const assetPath = path.join(assetsBasePath, assetName);
		logger.debug(
			`[COMMUNITY INVESTOR ASSET HANDLER] Attempting to serve asset: ${assetPath}`,
		);

		if (fs.existsSync(assetPath)) {
			const fileStream = fs.createReadStream(assetPath);
			let contentType = "application/octet-stream"; // Default
			if (assetPath.endsWith(".js")) contentType = "application/javascript";
			else if (assetPath.endsWith(".css")) contentType = "text/css";
			else if (assetPath.endsWith(".svg")) contentType = "image/svg+xml";
			else if (assetPath.endsWith(".png")) contentType = "image/png";
			else if (assetPath.endsWith(".jpg") || assetPath.endsWith(".jpeg"))
				contentType = "image/jpeg";
			else if (assetPath.endsWith(".gif")) contentType = "image/gif";
			else if (assetPath.endsWith(".ico")) contentType = "image/x-icon";
			else if (assetPath.endsWith(".woff")) contentType = "font/woff";
			else if (assetPath.endsWith(".woff2")) contentType = "font/woff2";

			nodeRes.writeHead(200, { "Content-Type": contentType });
			fileStream.pipe(nodeRes as unknown as NodeJS.WritableStream);
		} else {
			logger.warn(
				`[COMMUNITY INVESTOR ASSET HANDLER] Asset not found: ${assetPath}`,
			);
			sendError(res, 404, "NOT_FOUND", `Asset not found: ${assetName}`);
		}
	} catch (error: unknown) {
		logger.error(
			`[COMMUNITY INVESTOR ASSET HANDLER] Error serving asset ${req.path ?? ""}: ${errorMessage(error)}`,
		);
		sendError(
			res,
			500,
			"ASSET_ERROR",
			"Failed to load asset",
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
	{
		type: "GET",
		name: "Trust", // Matches panel path in plugin index
		path: "/display", // This will be /api/agents/:agentId/plugins/community-investor/display
		handler: communityInvestorPanelHandler,
		public: true, // Show the leaderboard panel
	},
	{
		type: "GET",
		name: "Trust Assets",
		path: "/assets/*", // To serve frontend assets
		handler: communityInvestorAssetsHandler,
		public: true, // Assets need to be public - REINSTATED
	},
];
