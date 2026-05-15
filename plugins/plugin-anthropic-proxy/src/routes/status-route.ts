/**
 * GET /api/anthropic-proxy/status
 *
 * External health/diagnostic surface for the Anthropic proxy.
 */

import type { IAgentRuntime, Route, RouteRequest, RouteResponse } from "@elizaos/core";
import {
	ANTHROPIC_PROXY_SERVICE_NAME,
	type AnthropicProxyService,
} from "../services/proxy-service.js";

async function handleStatus(
	_req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
): Promise<void> {
	const service = runtime.getService<AnthropicProxyService>(
		ANTHROPIC_PROXY_SERVICE_NAME,
	);
	if (!service) {
		res.status(503).json({
			error: "AnthropicProxyService not loaded",
		});
		return;
	}
	const status = await service.getStatus();
	res.status(200).json(status);
}

export const anthropicProxyRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/anthropic-proxy/status",
		handler: handleStatus,
		rawPath: true,
	},
];
