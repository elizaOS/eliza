/**
 * Route-level e2e for plugin-facewear (issue #8802).
 *
 * Boots the plugin's declared `Route[]` through the real production dispatcher
 * (`tryHandleRuntimePluginRoute`) over a loopback `http.createServer` —
 * exercising the real auth gate, route matching, `:id` param parsing, and
 * handler dispatch — with a faked `FacewearService` standing
 * in for the only external dependency. Every assertion is on a real
 * HTTP response; no `json`/`error` functions are mocked, no shapes are faked.
 *
 * Facewear routes use the canonical return-shape `routeHandler(ctx)->{status,
 * headers, body}` contract. `tryHandleRuntimePluginRoute` reads the legacy
 * `handler` field, so each route is bridged to a legacy `handler` with the same
 * adapter the runtime uses in production (`dispatch-route.ts`): build a
 * `RouteHandlerContext` from the dispatcher-augmented request, call
 * `routeHandler`, and write the structured result to the Node response.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentRuntime, Route, RouteHandlerContext } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";

import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { facewearPlugin } from "../index.ts";
import { FACEWEAR_SERVICE_TYPE } from "../services/facewear-service.ts";

const FACEWEAR_ROUTES = facewearPlugin.routes as Route[];

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

// ── routeHandler → legacy handler adapter ──────────────────────────────────
// Mirrors the production `routeHandler` invocation in
// packages/agent/src/api/dispatch-route.ts: build the canonical
// RouteHandlerContext from the request the dispatcher already augmented
// (.params/.query/.body), run routeHandler, and flush {status, headers, body}.

type AugmentedRequest = IncomingMessage & {
	params?: Record<string, string>;
	query?: Record<string, string | string[]>;
	body?: unknown;
	rawBody?: string;
	path?: string;
};

function headersToRecord(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(req.headers)) {
		out[key] = Array.isArray(value) ? value.join(",") : (value ?? "");
	}
	return out;
}

function bridgeToLegacyHandler(route: Route): Route {
	const routeHandler = route.routeHandler;
	if (!routeHandler) return route;
	return {
		...route,
		routeHandler: undefined,
		handler: async (req, res, runtime) => {
			const augmented = req as unknown as AugmentedRequest;
			const ctx: RouteHandlerContext = {
				body: augmented.body,
				rawBody: augmented.rawBody,
				params: augmented.params ?? {},
				query: augmented.query ?? {},
				headers: headersToRecord(req as unknown as IncomingMessage),
				method: (req as unknown as IncomingMessage).method ?? "GET",
				path: augmented.path ?? "",
				runtime,
				inProcess: false,
			};
			const result = await routeHandler(ctx);
			const response = res as unknown as ServerResponse;
			response.statusCode = result.status;
			for (const [key, value] of Object.entries(result.headers ?? {})) {
				response.setHeader(key, value);
			}
			if (result.body === undefined) {
				response.end();
				return;
			}
			if (typeof result.body === "string" || Buffer.isBuffer(result.body)) {
				if (!response.getHeader("Content-Type")) {
					response.setHeader("Content-Type", "text/plain; charset=utf-8");
				}
				response.end(result.body);
				return;
			}
			if (!response.getHeader("Content-Type")) {
				response.setHeader("Content-Type", "application/json; charset=utf-8");
			}
			response.end(JSON.stringify(result.body));
		},
	};
}

const BRIDGED_ROUTES = FACEWEAR_ROUTES.map(bridgeToLegacyHandler);

// ── Fake services ───────────────────────────────────────────────────────────

function makeFacewearService(
	devices: Array<{
		id: string;
		kind: "smartglasses";
		deviceType?: string;
	}>,
) {
	return {
		getConnectedDevices: () => devices,
	};
}

interface RuntimeServices {
	facewear?: ReturnType<typeof makeFacewearService> | null;
}

function makeRuntime(services: RuntimeServices = {}): AgentRuntime {
	return {
		routes: BRIDGED_ROUTES,
		getService: (key: string) => {
			if (key === FACEWEAR_SERVICE_TYPE) return services.facewear ?? null;
			return null;
		},
	} as unknown as AgentRuntime;
}

async function startServer(
	runtime: AgentRuntime,
	isAuthorized: () => boolean = () => true,
): Promise<string> {
	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const handled = await tryHandleRuntimePluginRoute({
			req,
			res,
			method: req.method ?? "GET",
			pathname: url.pathname,
			url,
			runtime,
			isAuthorized,
		});
		if (!handled && !res.headersSent) {
			res.statusCode = 404;
			res.end("not found");
		}
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}`;
}

describe("plugin-facewear routes (real dispatch)", () => {
	it("GET /api/facewear/devices lists the full device registry", async () => {
		const base = await startServer(makeRuntime());
		const res = await fetch(`${base}/api/facewear/devices`);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("application/json");
		const body = (await res.json()) as {
			devices: Array<{ id: string }>;
		};
		expect(Array.isArray(body.devices)).toBe(true);
		expect(body.devices.length).toBeGreaterThan(0);
		expect(body.devices.map((d) => d.id)).toContain("even-realities");
	});

	it("GET /api/facewear/devices/:id resolves a known profile via the :id param", async () => {
		const base = await startServer(makeRuntime());

		const known = await fetch(`${base}/api/facewear/devices/even-realities`);
		expect(known.status).toBe(200);
		expect(((await known.json()) as { id: string }).id).toBe("even-realities");

		// An unknown id is validated against the registry at the route boundary
		// (`isFacewearDeviceType`) and rejected with a real 404 instead of serving
		// an empty 200 body.
		const unknown = await fetch(`${base}/api/facewear/devices/does-not-exist`);
		expect(unknown.status).toBe(404);
		expect(unknown.headers.get("content-type")).toContain("application/json");
		expect(((await unknown.json()) as { error: string }).error).toBe(
			"Device not found",
		);
	});

	it("GET /api/facewear/status reports connected devices from FacewearService", async () => {
		const base = await startServer(
			makeRuntime({
				facewear: makeFacewearService([
					{ id: "smartglasses", kind: "smartglasses" },
				]),
			}),
		);
		const res = await fetch(`${base}/api/facewear/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			connected: boolean;
			devices: Array<{ id: string; kind: string }>;
		};
		expect(body.connected).toBe(true);
		expect(body.devices).toHaveLength(1);
		expect(body.devices[0]).toMatchObject({
			id: "smartglasses",
			kind: "smartglasses",
		});
	});

	it("GET /api/facewear/status returns an empty list when FacewearService is absent", async () => {
		const base = await startServer(makeRuntime({ facewear: null }));
		const res = await fetch(`${base}/api/facewear/status`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			connected: boolean;
			devices: unknown[];
		};
		expect(body.connected).toBe(false);
		expect(body.devices).toEqual([]);
	});

	it("enforces the auth gate on the non-public facewear routes (401)", async () => {
		// None of the facewear routes are declared `public: true`, so the auth gate
		// applies to all of them. With auth denied every route must 401 before the
		// handler runs.
		const base = await startServer(
			makeRuntime({ facewear: makeFacewearService([]) }),
			() => false,
		);

		for (const path of [
			"/api/facewear/devices",
			"/api/facewear/devices/even-realities",
			"/api/facewear/status",
		]) {
			const res = await fetch(`${base}${path}`);
			expect(res.status, `expected 401 for ${path}`).toBe(401);
			expect(((await res.json()) as { error: string }).error).toBe(
				"Unauthorized",
			);
		}
	});
});
