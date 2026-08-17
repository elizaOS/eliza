/**
 * Covers the BlueBubbles data + webhook routes' request guards: missing
 * `chatGuid`, hostile pagination clamping, webhook secret rejection, and
 * malformed-payload rejection before dispatch. Drives the route handlers with
 * hand-built runtime/request stubs — no live BlueBubbles server.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { blueBubblesDataRoutes } from "../src/data-routes";
import { BLUEBUBBLES_WEBHOOK_SECRET_HEADER } from "../src/webhook-auth";

function route(path: string, type: string) {
	const found = blueBubblesDataRoutes.find(
		(candidate) => candidate.path === path && candidate.type === type,
	);
	if (!found) {
		throw new Error(`Route not found: ${type} ${path}`);
	}
	return found;
}

function makeResponse() {
	const res = {
		status: vi.fn(() => res),
		json: vi.fn(() => res),
	} as unknown as RouteResponse & {
		status: ReturnType<typeof vi.fn>;
		json: ReturnType<typeof vi.fn>;
	};
	return res;
}

function makeRuntime(
	service: Record<string, unknown> | null,
	settings: Record<string, string> = {},
): IAgentRuntime {
	return {
		getService: vi.fn((serviceName: string) =>
			serviceName === "bluebubbles" ? service : null,
		),
		getSetting: vi.fn((key: string) => settings[key]),
	} as unknown as IAgentRuntime;
}

describe("blueBubblesDataRoutes", () => {
	it("rejects messages requests without a chatGuid before calling the client", async () => {
		const client = {
			getMessages: vi.fn(async () => []),
		};
		const service = {
			getClient: vi.fn(() => client),
		};
		const res = makeResponse();

		await route("/api/bluebubbles/messages", "GET").handler(
			{ url: "/api/bluebubbles/messages?limit=10" } as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: {
				code: "bad_request",
				message: "chatGuid query parameter is required",
			},
		});
		expect(client.getMessages).not.toHaveBeenCalled();
	});

	it("clamps an oversize canonical chat limit and keeps offset 0", async () => {
		const client = {
			listChats: vi.fn(async () => [{ guid: "chat-1" }]),
		};
		const service = {
			getClient: vi.fn(() => client),
		};
		const res = makeResponse();

		await route("/api/bluebubbles/chats", "GET").handler(
			{ url: "/api/bluebubbles/chats?limit=999999" } as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(client.listChats).toHaveBeenCalledWith(500, 0);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			chats: [{ guid: "chat-1" }],
			count: 1,
			limit: 500,
			offset: 0,
		});
	});

	it.each(["1e2", "12px", "007", "0", "0x10", "-1", "abc"])(
		"rejects prefix-coerced chat limit %j before listChats",
		async (limit) => {
			const client = {
				listChats: vi.fn(async () => [{ guid: "chat-1" }]),
			};
			const service = {
				getClient: vi.fn(() => client),
			};
			const res = makeResponse();

			await route("/api/bluebubbles/chats", "GET").handler(
				{ url: `/api/bluebubbles/chats?limit=${limit}` } as RouteRequest,
				res,
				makeRuntime(service),
			);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json).toHaveBeenCalledWith({
				error: {
					code: "bad_request",
					message: "limit must be a positive integer",
				},
			});
			expect(client.listChats).not.toHaveBeenCalled();
		},
	);

	it.each(["1e2", "12px", "007", "-20", "0x10", "abc"])(
		"rejects prefix-coerced or negative chat offset %j before listChats",
		async (offset) => {
			const client = {
				listChats: vi.fn(async () => [{ guid: "chat-1" }]),
			};
			const service = {
				getClient: vi.fn(() => client),
			};
			const res = makeResponse();

			await route("/api/bluebubbles/chats", "GET").handler(
				{ url: `/api/bluebubbles/chats?offset=${offset}` } as RouteRequest,
				res,
				makeRuntime(service),
			);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json).toHaveBeenCalledWith({
				error: {
					code: "bad_request",
					message: "offset must be a non-negative integer",
				},
			});
			expect(client.listChats).not.toHaveBeenCalled();
		},
	);

	it("accepts a canonical messages page and default offset", async () => {
		const client = {
			getMessages: vi.fn(async () => [{ guid: "m-1" }]),
		};
		const service = {
			getClient: vi.fn(() => client),
		};
		const res = makeResponse();

		await route("/api/bluebubbles/messages", "GET").handler(
			{
				url: "/api/bluebubbles/messages?chatGuid=chat-1&limit=20",
			} as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(client.getMessages).toHaveBeenCalledWith("chat-1", 20, 0);
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it.each(["1e2", "12px", "007", "0"])(
		"rejects prefix-coerced message limit %j before getMessages",
		async (limit) => {
			const client = {
				getMessages: vi.fn(async () => []),
			};
			const service = {
				getClient: vi.fn(() => client),
			};
			const res = makeResponse();

			await route("/api/bluebubbles/messages", "GET").handler(
				{
					url: `/api/bluebubbles/messages?chatGuid=chat-1&limit=${limit}`,
				} as RouteRequest,
				res,
				makeRuntime(service),
			);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(client.getMessages).not.toHaveBeenCalled();
		},
	);

	it("rejects webhooks without the configured shared secret", async () => {
		const service = {
			handleWebhook: vi.fn(async () => undefined),
		};
		const res = makeResponse();

		await route("/webhooks/bluebubbles", "POST").handler(
			{
				body: { type: "new-message", data: {} },
				headers: {},
			} as RouteRequest,
			res,
			makeRuntime(service, {
				BLUEBUBBLES_WEBHOOK_SECRET: "operator-secret",
			}),
		);

		expect(res.status).toHaveBeenCalledWith(401);
		expect(res.json).toHaveBeenCalledWith({
			error: { code: "unauthorized", message: "Unauthorized" },
		});
		expect(service.handleWebhook).not.toHaveBeenCalled();
	});

	it("rejects malformed webhook payloads before dispatch", async () => {
		const service = {
			handleWebhook: vi.fn(async () => undefined),
		};
		const res = makeResponse();

		await route("/webhooks/bluebubbles", "POST").handler(
			{
				body: { type: "new-message", data: null },
				headers: {
					[BLUEBUBBLES_WEBHOOK_SECRET_HEADER.toLowerCase()]: "operator-secret",
				},
			} as RouteRequest,
			res,
			makeRuntime(service, {
				BLUEBUBBLES_WEBHOOK_SECRET: "operator-secret",
			}),
		);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: {
				code: "bad_request",
				message: "invalid BlueBubbles webhook payload",
			},
		});
		expect(service.handleWebhook).not.toHaveBeenCalled();
	});
});
