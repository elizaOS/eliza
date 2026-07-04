/**
 * Unit tests for `discordDataRoutes` (guilds / channels / subscriptions) —
 * drives the route handlers against a mocked runtime and service.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { discordDataRoutes } from "../data-routes";
import { DISCORD_LOCAL_SERVICE_NAME } from "../discord-local-service";

function route(path: string, type: string) {
	const found = discordDataRoutes.find(
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

function makeRuntime(service: Record<string, unknown>): IAgentRuntime {
	return {
		getService: vi.fn((serviceName: string) =>
			serviceName === DISCORD_LOCAL_SERVICE_NAME ? service : null,
		),
	} as unknown as IAgentRuntime;
}

function makeService(overrides: Record<string, unknown> = {}) {
	return {
		getStatus: vi.fn(() => ({})),
		authorize: vi.fn(),
		disconnectSession: vi.fn(),
		listGuilds: vi.fn(async () => []),
		listChannels: vi.fn(async () => []),
		subscribeChannelMessages: vi.fn(async (channelIds: string[]) => channelIds),
		...overrides,
	};
}

describe("discordDataRoutes", () => {
	it("rejects malformed guildId before calling the local service", async () => {
		const service = makeService();
		const res = makeResponse();

		await route("/api/discord/channels", "GET").handler(
			{ url: "/api/discord/channels?guildId=../../etc/passwd" } as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: {
				code: "bad_request",
				message: "guildId must be a Discord snowflake",
			},
		});
		expect(service.listChannels).not.toHaveBeenCalled();
	});

	it("passes a valid guild snowflake through to listChannels", async () => {
		const service = makeService({
			listChannels: vi.fn(async () => [{ id: "222222222222222222" }]),
		});
		const res = makeResponse();

		await route("/api/discord/channels", "GET").handler(
			{
				url: "/api/discord/channels?guildId=111111111111111111",
			} as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(service.listChannels).toHaveBeenCalledWith("111111111111111111");
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			channels: [{ id: "222222222222222222" }],
			count: 1,
		});
	});

	it("rejects malformed channelIds before subscribing", async () => {
		const service = makeService();
		const res = makeResponse();

		await route("/api/discord/subscriptions", "POST").handler(
			{
				body: {
					channelIds: ["111111111111111111", "<script>alert(1)</script>"],
				},
			} as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({
			error: {
				code: "bad_request",
				message: "channelIds must contain only Discord snowflakes",
			},
		});
		expect(service.subscribeChannelMessages).not.toHaveBeenCalled();
	});

	it("trims and de-duplicates valid subscription channel snowflakes", async () => {
		const service = makeService();
		const res = makeResponse();

		await route("/api/discord/subscriptions", "POST").handler(
			{
				body: {
					channelIds: [
						" 111111111111111111 ",
						"111111111111111111",
						"222222222222222222",
					],
				},
			} as RouteRequest,
			res,
			makeRuntime(service),
		);

		expect(service.subscribeChannelMessages).toHaveBeenCalledWith([
			"111111111111111111",
			"222222222222222222",
		]);
		expect(res.status).toHaveBeenCalledWith(200);
		expect(res.json).toHaveBeenCalledWith({
			subscribedChannelIds: ["111111111111111111", "222222222222222222"],
		});
	});
});
