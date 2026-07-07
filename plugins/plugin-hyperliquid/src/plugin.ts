/**
 * The `@elizaos/plugin-hyperliquid` `Plugin` object: registers the
 * `PERPETUAL_MARKET` action, `PerpetualMarketService`, the read-only
 * `/api/hyperliquid/*` routes (all POST routes 501 — execution is disabled),
 * and the single GUI Hyperliquid view.
 * Route handlers bridge the elizaOS `RouteRequest`/`RouteResponse` shape to
 * Node's `http.IncomingMessage`/`http.ServerResponse`, which is what
 * `handleHyperliquidRoute` in `routes.ts` expects.
 */
import type http from "node:http";
import type {
	IAgentRuntime,
	Plugin,
	Route,
	RouteRequest,
	RouteResponse,
} from "@elizaos/core";
import {
	hyperliquidActions,
	PERPETUAL_MARKET_SERVICE_TYPE,
	PerpetualMarketService,
} from "./actions/perpetual-market";
import { handleHyperliquidRoute } from "./routes";

function toHttpIncomingMessage(req: RouteRequest): http.IncomingMessage {
	if (
		typeof req !== "object" ||
		req === null ||
		typeof req.method !== "string" ||
		typeof req.headers !== "object"
	) {
		throw new TypeError("Hyperliquid routes require a Node HTTP request");
	}
	return req as http.IncomingMessage;
}

function toHttpServerResponse(res: RouteResponse): http.ServerResponse {
	if (
		typeof res !== "object" ||
		res === null ||
		typeof res.end !== "function" ||
		typeof res.setHeader !== "function"
	) {
		throw new TypeError("Hyperliquid routes require a Node HTTP response");
	}
	return res as unknown as http.ServerResponse;
}

function hyperliquidRouteHandler(
	pathname: string,
): NonNullable<Route["handler"]> {
	return async (req, res) => {
		const httpReq = toHttpIncomingMessage(req);
		const httpRes = toHttpServerResponse(res);
		const method = (httpReq.method ?? "GET").toUpperCase();
		await handleHyperliquidRoute(httpReq, httpRes, pathname, method);
	};
}

const hyperliquidRoutes: Route[] = [
	{
		type: "GET",
		path: "/api/hyperliquid/status",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/status"),
	},
	{
		type: "GET",
		path: "/api/hyperliquid/markets",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/markets"),
	},
	{
		type: "GET",
		path: "/api/hyperliquid/funding",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/funding"),
	},
	{
		type: "GET",
		path: "/api/hyperliquid/positions",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/positions"),
	},
	{
		type: "GET",
		path: "/api/hyperliquid/orders",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/orders"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/orders/open",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/orders/open"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/orders/close",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/orders/close"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/leverage",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/leverage"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/margin",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/margin"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/bridge",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/bridge"),
	},
	{
		type: "POST",
		path: "/api/hyperliquid/tpsl",
		rawPath: true,
		handler: hyperliquidRouteHandler("/api/hyperliquid/tpsl"),
	},
];

export const hyperliquidPlugin: Plugin = {
	name: "@elizaos/plugin-hyperliquid",
	description:
		"Native Hyperliquid perpetual market status, market, position, and trading-readiness routes/actions for elizaOS",
	actions: hyperliquidActions,
	services: [PerpetualMarketService],
	routes: hyperliquidRoutes,
	views: [
		// ONE GUI declaration, drawn from the single
		// HyperliquidView spatial source. `modalities` is a plain literal here
		// (plugin.ts is not in the view bundle), so no brand-new `@elizaos/core`
		// runtime export reaches the bundle build.
		{
			id: "hyperliquid",
			label: "Hyperliquid",
			description:
				"Hyperliquid perpetual markets — positions, trading status, and market data",
			icon: "TrendingUp",
			path: "/hyperliquid",
			group: "wallet",
			modalities: ["gui"],
			bundlePath: "dist/views/bundle.js",
			// First-party instrumented view (data-agent-id controls): grant the
			// agent-surface capability so the view broker admits agent-driven
			// fills/clicks (#13452 manifest gate).
			surface: { capabilities: ["agent-surface"] },
			componentExport: "HyperliquidView",
			tags: ["trading", "perps", "hyperliquid", "crypto"],
			relatedActions: ["PERPETUAL_MARKET"],
			// Reached as a sub-view of Wallet (WalletSectionNav), not a launcher tile.
			visibleInManager: false,
			desktopTabEnabled: false,
		},
	],
	async dispose(runtime: IAgentRuntime) {
		const svc = runtime.getService<PerpetualMarketService>(
			PERPETUAL_MARKET_SERVICE_TYPE,
		);
		await svc?.stop();
	},
};
