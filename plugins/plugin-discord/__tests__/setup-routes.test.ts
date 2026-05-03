import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { discordSetupRoutes } from "../setup-routes";

function createResponse() {
	let statusCode = 0;
	let jsonBody: unknown;

	const response: RouteResponse = {
		status(code: number) {
			statusCode = code;
			return response;
		},
		json(data: unknown) {
			jsonBody = data;
			return response;
		},
		send(data: unknown) {
			jsonBody = data;
			return response;
		},
		end() {
			return response;
		},
	};

	return {
		response,
		get statusCode() {
			return statusCode;
		},
		get jsonBody() {
			return jsonBody;
		},
	};
}

describe("discord setup routes", () => {
	it("returns a complete local status DTO when the service is not registered", async () => {
		const route = discordSetupRoutes.find(
			(candidate) =>
				candidate.type === "GET" &&
				candidate.path === "/api/discord-local/status",
		);
		if (!route?.handler) {
			throw new Error("Discord local status route is not registered");
		}

		const response = createResponse();
		const runtime = {
			getService: () => null,
		} as unknown as IAgentRuntime;

		await route.handler({} as RouteRequest, response.response, runtime);

		expect(response.statusCode).toBe(200);
		expect(response.jsonBody).toEqual({
			available: false,
			connected: false,
			authenticated: false,
			currentUser: null,
			subscribedChannelIds: [],
			configuredChannelIds: [],
			scopes: [],
			lastError: "discord-local service not registered",
			ipcPath: null,
			reason: "discord-local service not registered",
		});
	});
});
