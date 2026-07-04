/**
 * Route-level e2e for plugin-xr (issue #8802).
 *
 * Boots the plugin's declared `Route[]` through the REAL production dispatcher
 * over a loopback `http.createServer`, exercising the real auth gate, query
 * parsing, param extraction, and `routeHandler` return-shape marshaling — with a
 * faked `XRSessionService` standing in for the only runtime dependency.
 *
 * The XR routes use the canonical return-shape `routeHandler(ctx) -> {status,
 * headers, body}` contract. In production those routes are dispatched by
 * `mountRoutesOnHono` -> `dispatchRoute` (packages/agent/src/api/hono-adapter.ts
 * + dispatch-route.ts), NOT by the legacy `tryHandleRuntimePluginRoute` (which
 * only invokes the Express-shaped `route.handler`). This test drives the actual
 * production path: it builds the real Hono app for the runtime and serves its
 * `fetch` handler over a real TCP socket, asserting on live HTTP responses.
 *
 * No mocked `json`/`error` helpers, no shape-only checks: every assertion is on
 * a real HTTP response delivered over the loopback socket.
 */

import { Buffer } from "node:buffer";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { buildHonoAppForRuntime } from "../../../../packages/agent/src/api/hono-adapter.ts";
import { xrConnectRoute } from "../routes/xr-connect.ts";
import { xrSimulatorRoute } from "../routes/xr-simulator-route.ts";
import { xrStatusRoute } from "../routes/xr-status.ts";
import { xrViewHostRoute } from "../routes/xr-view-host.ts";
import { xrViewsRoute } from "../routes/xr-views.ts";
import { XR_SERVICE_TYPE } from "../services/xr-session-service.ts";

const XR_ROUTES = [
	xrStatusRoute,
	xrConnectRoute,
	xrViewsRoute,
	xrViewHostRoute,
	xrSimulatorRoute,
];

const servers: http.Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections?.();
					server.close(() => resolve());
				}),
		),
	);
	servers.length = 0;
});

interface FakeConnection {
	id: string;
	deviceType: string;
	connectedAt: Date;
}

function makeRuntime(
	options: {
		withService?: boolean;
		connections?: FakeConnection[];
		recentFrameIds?: string[];
	} = {},
): IAgentRuntime {
	const { withService = true, connections = [], recentFrameIds = [] } = options;

	const recent = new Set(recentFrameIds);
	const service = {
		getConnections: () => connections,
		getVisionPipeline: () => ({
			hasRecentFrame: (id: string) => recent.has(id),
		}),
	};

	return {
		routes: XR_ROUTES,
		getService: (key: string) =>
			withService && key === XR_SERVICE_TYPE ? service : null,
		// xrViewHostRoute reads `runtime.port` to build the bundle origin.
		port: 31337,
	} as unknown as IAgentRuntime;
}

/**
 * Serve the real production Hono app (built from `runtime.routes`) over a real
 * loopback TCP socket. Bridges the Node request/response to Hono's standard
 * `fetch` handler so assertions run against genuine HTTP — not an in-memory
 * handler invocation.
 */
async function startServer(
	runtime: IAgentRuntime,
	isAuthorized: () => boolean = () => true,
): Promise<string> {
	const app = buildHonoAppForRuntime(runtime, { isAuthorized });

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk) => chunks.push(chunk as Buffer));
		req.on("end", () => {
			void (async () => {
				const url = `http://127.0.0.1${req.url ?? "/"}`;
				const method = req.method ?? "GET";
				const headers = new Headers();
				for (const [key, value] of Object.entries(req.headers)) {
					if (value === undefined) continue;
					headers.set(key, Array.isArray(value) ? value.join(", ") : value);
				}
				const hasBody = method !== "GET" && method !== "HEAD";
				const request = new Request(url, {
					method,
					headers,
					body: hasBody && chunks.length ? Buffer.concat(chunks) : undefined,
				});

				const response = await app.fetch(request);

				res.statusCode = response.status;
				response.headers.forEach((value, key) => {
					res.setHeader(key, value);
				});
				const buf = Buffer.from(await response.arrayBuffer());
				res.end(buf);
			})();
		});
	});

	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

describe("plugin-xr routes (real dispatch)", () => {
	it("serves /xr/status with the connected-device list when the service is present", async () => {
		const connectedAt = new Date("2024-01-01T00:00:00.000Z");
		const base = await startServer(
			makeRuntime({
				connections: [
					{ id: "conn-a", deviceType: "quest3", connectedAt },
					{ id: "conn-b", deviceType: "xreal", connectedAt },
				],
				recentFrameIds: ["conn-a"],
			}),
		);

		const res = await fetch(`${base}/xr/status`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");

		const body = (await res.json()) as {
			connected: boolean;
			connections: Array<{
				id: string;
				deviceType: string;
				connectedAt: string;
				hasRecentFrame: boolean;
			}>;
		};
		expect(body.connected).toBe(true);
		expect(body.connections).toHaveLength(2);
		expect(body.connections[0]).toEqual({
			id: "conn-a",
			deviceType: "quest3",
			connectedAt: "2024-01-01T00:00:00.000Z",
			hasRecentFrame: true,
		});
		expect(body.connections[1].hasRecentFrame).toBe(false);
	});

	it("reports connected:false when the service has no active connections", async () => {
		const base = await startServer(makeRuntime({ connections: [] }));
		const res = await fetch(`${base}/xr/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			connected: boolean;
			connections: unknown[];
		};
		expect(body.connected).toBe(false);
		expect(body.connections).toEqual([]);
	});

	it("returns 503 from /xr/status when the XR service is unavailable", async () => {
		const base = await startServer(makeRuntime({ withService: false }));
		const res = await fetch(`${base}/xr/status`);
		expect(res.status).toBe(503);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("XR service not running");
	});

	it("enforces the auth gate on the non-public /xr/status route", async () => {
		const base = await startServer(makeRuntime(), () => false);
		const res = await fetch(`${base}/xr/status`);
		expect(res.status).toBe(401);
		expect(((await res.json()) as { error: string }).error).toBe(
			"Unauthorized",
		);
	});

	it("serves /xr/connect as an HTML pairing page when authorized", async () => {
		const base = await startServer(makeRuntime());
		const res = await fetch(`${base}/xr/connect`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain("<!DOCTYPE html>");
		expect(html).toContain("Connect XR Headset");
	});

	it("auth-gates /xr/connect when the request is unauthorized", async () => {
		const base = await startServer(makeRuntime(), () => false);
		const res = await fetch(`${base}/xr/connect`);
		expect(res.status).toBe(401);
	});

	it("serves /xr/views with views, count, and live connections", async () => {
		const base = await startServer(
			makeRuntime({
				connections: [
					{
						id: "conn-a",
						deviceType: "quest3",
						connectedAt: new Date("2024-01-01T00:00:00.000Z"),
					},
				],
			}),
		);
		const res = await fetch(`${base}/xr/views`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			views: unknown[];
			count: number;
			connections: Array<{ id: string; deviceType: string }>;
		};
		expect(Array.isArray(body.views)).toBe(true);
		expect(body.count).toBe(body.views.length);
		expect(body.connections).toEqual([{ id: "conn-a", deviceType: "quest3" }]);
	});

	it("serves /xr/view-host/:id HTML with the extracted view id", async () => {
		const base = await startServer(makeRuntime());
		const res = await fetch(`${base}/xr/view-host/wallet`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		expect(html).toContain('data-view-id="wallet"');
		expect(html).toContain("/api/views/wallet/bundle.js");
		expect(res.headers.get("content-security-policy")).toContain("esm.sh");
	});

	it("serves /xr/simulator.js according to whether the emulator bundle is built", async () => {
		const base = await startServer(makeRuntime());
		const res = await fetch(`${base}/xr/simulator.js`);

		// The route's two real branches: 200 + JS when the simulator bundle has
		// been built, 404 + a build hint otherwise. Both are exercised here over
		// real HTTP; which one fires depends on whether `simulator:build` has run.
		if (res.status === 200) {
			expect(res.headers.get("content-type")).toContain(
				"application/javascript",
			);
			const js = await res.text();
			expect(js.length).toBeGreaterThan(0);
		} else {
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: string; hint: string };
			expect(body.error).toContain("Emulator bundle not built");
			expect(body.hint).toContain("simulator");
		}
	});
});
