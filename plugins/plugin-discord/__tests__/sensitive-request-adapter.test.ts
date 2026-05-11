import type { IAgentRuntime, SensitiveRequest } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDiscordDmSensitiveRequestAdapter } from "../sensitive-request-adapter";

interface MockDmChannel {
	id: string;
	send: ReturnType<typeof vi.fn>;
}

interface MockUser {
	createDM: ReturnType<typeof vi.fn>;
}

function makeMockDiscord(
	dmId = "dm-channel-123",
	throwOn?: "fetch" | "createDM" | "send",
) {
	const dmChannel: MockDmChannel = {
		id: dmId,
		send: vi.fn(async () => ({ id: "msg-1" })),
	};
	if (throwOn === "send") {
		dmChannel.send = vi.fn(async () => {
			throw new Error("send failed");
		});
	}
	const user: MockUser = {
		createDM: vi.fn(async () => dmChannel),
	};
	if (throwOn === "createDM") {
		user.createDM = vi.fn(async () => {
			throw new Error("createDM failed");
		});
	}
	const fetch = vi.fn(async () => user);
	const fetchThrowing = vi.fn(async () => {
		throw new Error("fetch failed");
	});
	const client = {
		users: { fetch: throwOn === "fetch" ? fetchThrowing : fetch },
	};
	return { client, user, dmChannel };
}

function makeRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
	return {
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		...overrides,
	} as unknown as IAgentRuntime;
}

function makeRequest(
	overrides: Partial<SensitiveRequest> = {},
): SensitiveRequest {
	return {
		id: "req-1",
		kind: "secret",
		status: "pending",
		agentId: "agent-1",
		requesterEntityId: "user-snowflake-9999",
		target: { kind: "secret", key: "OPENAI_API_KEY" },
		policy: {
			actor: "owner_or_linked_identity",
			requirePrivateDelivery: true,
			requireAuthenticatedLink: true,
			allowInlineOwnerAppEntry: true,
			allowPublicLink: false,
			allowDmFallback: true,
			allowTunnelLink: true,
			allowCloudLink: true,
		},
		delivery: {
			kind: "secret",
			source: "dm",
			mode: "private_dm",
			policy: {
				actor: "owner_or_linked_identity",
				requirePrivateDelivery: true,
				requireAuthenticatedLink: true,
				allowInlineOwnerAppEntry: true,
				allowPublicLink: false,
				allowDmFallback: true,
				allowTunnelLink: true,
				allowCloudLink: true,
			},
			privateRouteRequired: true,
			publicLinkAllowed: false,
			authenticated: false,
			canCollectValueInCurrentChannel: true,
			reason: "current channel is private",
			instruction: "Provide the secret in this DM.",
		},
		expiresAt: "2099-01-01T00:00:00.000Z",
		createdAt: "2026-05-10T00:00:00.000Z",
		updatedAt: "2026-05-10T00:00:00.000Z",
		...overrides,
	} as SensitiveRequest;
}

describe("discordDmSensitiveRequestAdapter", () => {
	let mockDiscord: ReturnType<typeof makeMockDiscord>;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		mockDiscord = makeMockDiscord();
		runtime = makeRuntime();
	});

	it("declares target 'dm'", () => {
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: mockDiscord.client }) as never,
		});
		expect(adapter.target).toBe("dm");
	});

	it("happy path: sends a DM and returns delivered=true with channel id and expiresAt", async () => {
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: mockDiscord.client }) as never,
		});
		const request = makeRequest();
		const result = await adapter.deliver({
			request,
			channelId: "user-snowflake-1234",
			runtime,
		});

		expect(result).toEqual({
			delivered: true,
			target: "dm",
			channelId: "dm-channel-123",
			expiresAt: request.expiresAt,
		});
		expect(mockDiscord.client.users.fetch).toHaveBeenCalledWith(
			"user-snowflake-1234",
		);
		expect(mockDiscord.user.createDM).toHaveBeenCalledTimes(1);
		expect(mockDiscord.dmChannel.send).toHaveBeenCalledTimes(1);
		const sendArg = mockDiscord.dmChannel.send.mock.calls[0]?.[0] as {
			content: string;
		};
		expect(sendArg.content).toContain(request.delivery.instruction);
		expect(sendArg.content).toContain(request.expiresAt);
	});

	it("falls back to request.requesterEntityId when channelId is not provided", async () => {
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: mockDiscord.client }) as never,
		});
		const request = makeRequest({ requesterEntityId: "user-snowflake-9999" });
		const result = await adapter.deliver({ request, runtime });

		expect(result.delivered).toBe(true);
		expect(mockDiscord.client.users.fetch).toHaveBeenCalledWith(
			"user-snowflake-9999",
		);
	});

	it("returns delivered=false with error when neither channelId nor requesterEntityId is set", async () => {
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: mockDiscord.client }) as never,
		});
		const request = makeRequest({ requesterEntityId: null });
		const result = await adapter.deliver({ request, runtime });

		expect(result.delivered).toBe(false);
		expect(result.error).toMatch(/no discord user id/i);
		expect(mockDiscord.client.users.fetch).not.toHaveBeenCalled();
	});

	it("returns delivered=false with 'Discord service unavailable' when service is missing", async () => {
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => null,
		});
		const result = await adapter.deliver({
			request: makeRequest(),
			channelId: "user-1",
			runtime,
		});
		expect(result).toEqual({
			delivered: false,
			target: "dm",
			error: "Discord service unavailable",
		});
	});

	it("failure path: surfaces error message when send throws", async () => {
		const failing = makeMockDiscord("dm-x", "send");
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: failing.client }) as never,
		});
		const result = await adapter.deliver({
			request: makeRequest(),
			channelId: "user-1",
			runtime,
		});
		expect(result.delivered).toBe(false);
		expect(result.error).toBe("send failed");
	});

	it("failure path: surfaces error when users.fetch throws", async () => {
		const failing = makeMockDiscord("dm-x", "fetch");
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: failing.client }) as never,
		});
		const result = await adapter.deliver({
			request: makeRequest(),
			channelId: "user-1",
			runtime,
		});
		expect(result.delivered).toBe(false);
		expect(result.error).toBe("fetch failed");
	});

	it("includes the cloud-hosted link when kind=secret and cloud is paired", async () => {
		const cloudRuntime = makeRuntime({
			getSetting: vi.fn((key: string) =>
				key === "ELIZA_CLOUD_API_KEY" ? "cloud-key-abc" : undefined,
			) as IAgentRuntime["getSetting"],
		});
		const adapter = createDiscordDmSensitiveRequestAdapter({
			getDiscordService: () => ({ client: mockDiscord.client }) as never,
		});
		const request = makeRequest({
			delivery: {
				...makeRequest().delivery,
				mode: "cloud_authenticated_link",
				linkBaseUrl: "https://cloud.eliza.example/secret/req-1",
			},
		});
		const result = await adapter.deliver({
			request,
			channelId: "user-1",
			runtime: cloudRuntime,
		});
		expect(result.delivered).toBe(true);
		const sent = mockDiscord.dmChannel.send.mock.calls[0]?.[0] as {
			content: string;
		};
		expect(sent.content).toContain(
			"https://cloud.eliza.example/secret/req-1",
		);
	});
});
