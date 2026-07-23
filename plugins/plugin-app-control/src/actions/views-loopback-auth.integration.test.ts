/**
 * Real TCP coverage for app-control view requests crossing a bearer-protected
 * loopback boundary through the client, show path, and public action handlers.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackgroundAction } from "./background.js";
import { createSettingsAction } from "./settings.js";
import { createViewsAction } from "./views.js";
import {
	createViewsClient,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";
import { runViewsShow } from "./views-show.js";

interface CapturedRequest {
	method: string;
	pathname: string;
	authorization: string | undefined;
	body: string;
}

interface AuthenticatedViewsServer {
	port: number;
	requests: CapturedRequest[];
}

const ENV_KEYS = [
	"ELIZA_PORT",
	"ELIZA_UI_PORT",
	"ELIZA_API_TOKEN",
	"ELIZA_API_AUTH_TOKEN",
] as const;

const SETTINGS_VIEW: ViewSummary = {
	id: "settings",
	label: "Settings",
	path: "/settings",
	pluginName: "core",
	available: true,
	viewType: "gui",
};

const NOTES_VIEW: ViewSummary = {
	id: "notes",
	label: "Notes",
	path: "/notes",
	pluginName: "plugin-simple-views",
	available: true,
	viewType: "gui",
};

const servers: http.Server[] = [];
let previousEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;

function sendJson(
	res: http.ServerResponse,
	status: number,
	body: unknown,
): void {
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}

async function readRequestBody(req: http.IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function startAuthenticatedViewsServer(
	expectedToken: string,
): Promise<AuthenticatedViewsServer> {
	const requests: CapturedRequest[] = [];
	const server = http.createServer((req, res) => {
		void (async () => {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const body = await readRequestBody(req);
			const request = {
				method: req.method ?? "GET",
				pathname: url.pathname,
				authorization: req.headers.authorization,
				body,
			};
			requests.push(request);

			if (request.authorization !== `Bearer ${expectedToken}`) {
				sendJson(res, 401, { error: "Unauthorized" });
				return;
			}

			if (request.method === "GET" && request.pathname === "/api/views") {
				sendJson(res, 200, { views: [SETTINGS_VIEW, NOTES_VIEW] });
				return;
			}
			if (
				request.method === "GET" &&
				request.pathname === "/api/views/search"
			) {
				sendJson(res, 200, {
					results: [{ ...SETTINGS_VIEW, _score: 100 }],
				});
				return;
			}
			if (
				request.method === "GET" &&
				request.pathname === "/api/views/current"
			) {
				sendJson(res, 200, {
					currentView: {
						viewId: "settings",
						viewPath: "/settings",
						viewLabel: "Settings",
						viewType: "gui",
						updatedAt: "2026-07-22T20:00:00.000Z",
					},
				});
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname.startsWith("/api/views/") &&
				request.pathname.endsWith("/navigate")
			) {
				sendJson(res, 200, { ok: true });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname.startsWith("/api/views/") &&
				request.pathname.endsWith("/interact")
			) {
				sendJson(res, 200, { success: true, text: "interaction complete" });
				return;
			}
			if (
				request.method === "POST" &&
				request.pathname === "/api/views/events/broadcast"
			) {
				sendJson(res, 200, { ok: true });
				return;
			}
			sendJson(res, 404, { error: "Not found" });
		})().catch((error: unknown) => {
			sendJson(res, 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		port: (server.address() as AddressInfo).port,
		requests,
	};
}

beforeEach(() => {
	previousEnv = Object.fromEntries(
		ENV_KEYS.map((key) => [key, process.env[key]]),
	) as Record<(typeof ENV_KEYS)[number], string | undefined>;
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
	for (const key of ENV_KEYS) {
		const value = previousEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("authenticated view loopback requests", () => {
	it("uses the canonical token, falls back to the legacy key, and omits empty auth", () => {
		expect(
			createViewsRequestHeaders({
				ELIZA_API_TOKEN: " canonical-token ",
				ELIZA_API_AUTH_TOKEN: "legacy-token",
			}),
		).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer canonical-token",
		});
		expect(
			createViewsRequestHeaders({
				ELIZA_API_AUTH_TOKEN: " legacy-token ",
			}),
		).toEqual({
			"Content-Type": "application/json",
			Authorization: "Bearer legacy-token",
		});
		expect(createViewsRequestHeaders({})).toEqual({
			"Content-Type": "application/json",
		});
	});

	it("authenticates every ViewsClient route across a real HTTP boundary", async () => {
		const token = "views-client-test-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);

		const unauthenticated = await fetch(
			`http://127.0.0.1:${server.port}/api/views`,
		);
		expect(unauthenticated.status).toBe(401);

		process.env.ELIZA_API_TOKEN = token;
		const client = createViewsClient();
		await expect(client.listViews()).resolves.toEqual([
			SETTINGS_VIEW,
			NOTES_VIEW,
		]);
		await expect(client.getCurrentView()).resolves.toMatchObject({
			viewId: "settings",
			viewPath: "/settings",
		});
		await expect(
			client.navigate("settings", { path: "/settings", viewType: "gui" }),
		).resolves.toBe(true);

		const authenticated = server.requests.filter(
			(request) => request.authorization !== undefined,
		);
		expect(
			authenticated.map(({ method, pathname }) => ({ method, pathname })),
		).toEqual([
			{ method: "GET", pathname: "/api/views" },
			{ method: "GET", pathname: "/api/views/current" },
			{ method: "POST", pathname: "/api/views/settings/navigate" },
		]);
		expect(
			authenticated.every(
				(request) => request.authorization === `Bearer ${token}`,
			),
		).toBe(true);
		expect(authenticated[2]?.body).toBe(
			JSON.stringify({ path: "/settings", viewType: "gui" }),
		);
		for (const request of authenticated) {
			expect(`${request.pathname}\n${request.body}`).not.toContain(token);
		}
	});

	it("authenticates the show action's direct navigate path with the legacy key", async () => {
		const token = "views-show-legacy-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_AUTH_TOKEN = token;

		const client: ViewsClient = {
			listViews: async () => [SETTINGS_VIEW],
			getCurrentView: async () => null,
			navigate: async () => false,
		};
		const result = await runViewsShow({
			client,
			message: {
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text: "go to settings" },
			} as never,
		});

		expect(result.success).toBe(true);
		expect(result.values?.viewId).toBe("settings");
		expect(server.requests).toHaveLength(1);
		expect(server.requests[0]).toMatchObject({
			method: "POST",
			pathname: "/api/views/settings/navigate",
			authorization: `Bearer ${token}`,
		});
		expect(server.requests[0]?.body).toBe(
			JSON.stringify({ path: "/settings" }),
		);
		expect(
			`${server.requests[0]?.pathname}\n${server.requests[0]?.body}`,
		).not.toContain(token);
	});

	it("authenticates every Node-side views loopback caller", async () => {
		const token = "all-views-callers-token";
		const server = await startAuthenticatedViewsServer(token);
		process.env.ELIZA_PORT = String(server.port);
		process.env.ELIZA_API_TOKEN = token;

		const runtime = { agentId: "agent-1" } as never;
		const message = (text: string) =>
			({
				entityId: "user-1",
				roomId: "room-1",
				agentId: "agent-1",
				content: { text },
			}) as never;
		const viewsAction = createViewsAction({
			hasOwnerAccess: async () => true,
		});
		const invokeViews = async (
			text: string,
			options: Record<string, unknown>,
		) => {
			const result = await viewsAction.handler(
				runtime,
				message(text),
				undefined,
				options,
			);
			expect(result.success).toBe(true);
		};

		await invokeViews("open view manager", { action: "manager" });
		await invokeViews("pin settings", { action: "pin", view: "settings" });
		await invokeViews("split settings and notes", {
			action: "split",
			views: ["settings", "notes"],
		});
		await invokeViews("interact with settings", {
			action: "interact",
			view: "settings",
			capability: "get-state",
		});
		await invokeViews("broadcast refresh", {
			action: "broadcast",
			eventType: "demo:refresh",
		});
		await invokeViews("search views settings", {
			action: "search",
			query: "settings",
		});

		const backgroundAction = createBackgroundAction();
		const backgroundResult = await backgroundAction.handler(
			runtime,
			message("make the background green"),
		);
		expect(backgroundResult.success).toBe(true);
		const backgroundNavigateResult = await backgroundAction.handler(
			runtime,
			message("i want to upload my own background image"),
		);
		expect(backgroundNavigateResult.success).toBe(true);

		const settingsAction = createSettingsAction();
		const settingsResult = await settingsAction.handler(
			runtime,
			message("use dark mode"),
			undefined,
			{
				action: "set",
				section: "appearance",
				key: "theme",
				value: "dark",
			},
		);
		expect(settingsResult.success).toBe(true);

		const paths = server.requests.map((request) => request.pathname);
		expect(paths).toEqual(
			expect.arrayContaining([
				"/api/views/__view-manager__/navigate",
				"/api/views/settings/navigate",
				"/api/views/settings/interact",
				"/api/views/events/broadcast",
				"/api/views/search",
				"/api/views/background/navigate",
			]),
		);
		expect(
			server.requests.every(
				(request) => request.authorization === `Bearer ${token}`,
			),
		).toBe(true);
		for (const request of server.requests) {
			expect(`${request.pathname}\n${request.body}`).not.toContain(token);
		}
	});
});
