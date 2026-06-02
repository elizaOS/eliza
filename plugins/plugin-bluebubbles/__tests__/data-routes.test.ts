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

	it("clamps hostile pagination values for chat listing", async () => {
		const client = {
			listChats: vi.fn(async () => [{ guid: "chat-1" }]),
		};
		const service = {
			getClient: vi.fn(() => client),
		};
		const res = makeResponse();

		await route("/api/bluebubbles/chats", "GET").handler(
			{ url: "/api/bluebubbles/chats?limit=999999&offset=-20" } as RouteRequest,
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
