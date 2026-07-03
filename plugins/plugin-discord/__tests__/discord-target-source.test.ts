import {
	CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
	type IAgentRuntime,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	createDiscordSourceCache,
	createDiscordTargetSource,
	fetchDiscordEnumeration,
	formatDiscordEnumerationAsFacts,
	registerDiscordTargetSource,
} from "../discord-target-source";

const GUILDS_URL = "https://discord.com/api/v10/users/@me/guilds";
const channelsUrl = (id: string) =>
	`https://discord.com/api/v10/guilds/${id}/channels`;

interface FakeResponse {
	ok: boolean;
	status?: number;
	json: () => Promise<unknown>;
}

function makeFetch(routes: Record<string, FakeResponse>) {
	return vi.fn(async (url: string): Promise<Response> => {
		const route = routes[url];
		if (!route) throw new Error(`unexpected url ${url}`);
		return {
			ok: route.ok,
			status: route.status ?? (route.ok ? 200 : 500),
			json: route.json,
		} as Response;
	}) as unknown as typeof fetch;
}

const happyRoutes = () => ({
	[GUILDS_URL]: {
		ok: true,
		json: async () => [{ id: "g1", name: "Cozy Devs" }],
	},
	[channelsUrl("g1")]: {
		ok: true,
		json: async () => [
			{ id: "c1", name: "general", type: 0 },
			{ id: "c2", name: "voice", type: 2 },
		],
	},
});

describe("fetchDiscordEnumeration", () => {
	it("enumerates guilds and text-only channels", async () => {
		const fetchImpl = makeFetch(happyRoutes());
		const result = await fetchDiscordEnumeration("bot-token", { fetchImpl });
		expect(result).toEqual([
			{
				guildId: "g1",
				guildName: "Cozy Devs",
				channels: [{ id: "c1", name: "general" }],
			},
		]);
	});

	it("reuses the shared cache for repeat calls within the TTL", async () => {
		const fetchImpl = makeFetch(happyRoutes());
		const cache = createDiscordSourceCache();
		let clock = 1000;
		const now = () => clock;

		await fetchDiscordEnumeration("bot-token", { fetchImpl, cache, now });
		expect(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		).toHaveBeenCalledTimes(2);

		clock += 60_000; // still inside the 5-minute window
		await fetchDiscordEnumeration("bot-token", { fetchImpl, cache, now });
		// No new REST calls — served from cache.
		expect(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		).toHaveBeenCalledTimes(2);

		clock += 5 * 60 * 1000; // past the window → refetch
		await fetchDiscordEnumeration("bot-token", { fetchImpl, cache, now });
		expect(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		).toHaveBeenCalledTimes(4);
	});

	it("returns [] when the guilds endpoint is non-ok", async () => {
		const fetchImpl = makeFetch({
			[GUILDS_URL]: { ok: false, status: 401, json: async () => ({}) },
		});
		expect(await fetchDiscordEnumeration("bot-token", { fetchImpl })).toEqual(
			[],
		);
	});

	it("marks channelsError when a guild's channels endpoint is non-ok", async () => {
		const fetchImpl = makeFetch({
			[GUILDS_URL]: {
				ok: true,
				json: async () => [{ id: "g1", name: "Cozy Devs" }],
			},
			[channelsUrl("g1")]: { ok: false, status: 403, json: async () => ({}) },
		});
		expect(await fetchDiscordEnumeration("bot-token", { fetchImpl })).toEqual([
			{ guildId: "g1", guildName: "Cozy Devs", channelsError: { status: 403 } },
		]);
	});
});

describe("createDiscordTargetSource", () => {
	it("maps enumeration to TargetGroups, reading the token from getConfig", async () => {
		const fetchImpl = makeFetch(happyRoutes());
		const source = createDiscordTargetSource();
		const groups = await source.enumerate({
			getConfig: () => ({ connectors: { discord: { token: "bot-token" } } }),
			fetchImpl,
		});
		expect(source.platform).toBe("discord");
		expect(groups).toEqual([
			{
				platform: "discord",
				groupId: "g1",
				groupName: "Cozy Devs",
				targets: [{ id: "c1", name: "general", kind: "channel" }],
			},
		]);
	});

	it("returns [] when no Discord token is configured (done-when: empty)", async () => {
		const fetchImpl = makeFetch(happyRoutes());
		const source = createDiscordTargetSource();
		expect(
			await source.enumerate({ getConfig: () => ({}), fetchImpl }),
		).toEqual([]);
		expect(
			fetchImpl as unknown as ReturnType<typeof vi.fn>,
		).not.toHaveBeenCalled();
	});

	it("filters to a single guild when groupId is set", async () => {
		const fetchImpl = makeFetch({
			[GUILDS_URL]: {
				ok: true,
				json: async () => [
					{ id: "g1", name: "Cozy Devs" },
					{ id: "g2", name: "Other" },
				],
			},
			[channelsUrl("g1")]: {
				ok: true,
				json: async () => [{ id: "c1", name: "general", type: 0 }],
			},
			[channelsUrl("g2")]: {
				ok: true,
				json: async () => [{ id: "c9", name: "misc", type: 0 }],
			},
		});
		const source = createDiscordTargetSource();
		const groups = await source.enumerate({
			getConfig: () => ({ connectors: { discord: { token: "bot-token" } } }),
			fetchImpl,
			groupId: "g2",
		});
		expect(groups.map((g) => g.groupId)).toEqual(["g2"]);
	});
});

describe("registerDiscordTargetSource", () => {
	it("registers a discord source into the runtime's registry service", () => {
		const register = vi.fn();
		const runtime = {
			getService: vi.fn((name: string) =>
				name === CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE ? { register } : null,
			),
		} as unknown as IAgentRuntime;

		registerDiscordTargetSource(runtime);

		expect(runtime.getService).toHaveBeenCalledWith(
			CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
		);
		expect(register).toHaveBeenCalledOnce();
		expect(register.mock.calls[0]?.[0]?.platform).toBe("discord");
	});

	it("defers one tick when the registry is not yet present", async () => {
		const register = vi.fn();
		let present = false;
		const runtime = {
			getService: vi.fn(() => (present ? { register } : null)),
		} as unknown as IAgentRuntime;

		registerDiscordTargetSource(runtime);
		expect(register).not.toHaveBeenCalled();

		present = true;
		await new Promise((r) => setImmediate(r));
		expect(register).toHaveBeenCalledOnce();
	});
});

describe("formatDiscordEnumerationAsFacts", () => {
	it("formats channels and channel errors into prompt fact strings", () => {
		const facts = formatDiscordEnumerationAsFacts([
			{
				guildId: "g1",
				guildName: "Cozy Devs",
				channels: [{ id: "c1", name: "general" }],
			},
			{ guildId: "g2", guildName: "Other", channelsError: { status: 403 } },
		]);
		expect(facts).toEqual([
			'Discord guild "Cozy Devs" (id g1) channels: #general (c1).',
			'Discord guild "Other" (id g2) — channels not enumerable (status 403).',
		]);
	});
});
