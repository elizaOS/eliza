/**
 * Exercises Discord guild-management destination binding and connector-boundary
 * revalidation with the production authorization helpers over a mutable
 * deterministic runtime. No Discord API calls are made.
 */

import {
	authorizeManageServerDestination,
	createUniqueUuid,
	ElizaError,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import type { ManageableGuild } from "../guild-management";
import {
	resolveDiscordManageServerDestination,
	revalidateDiscordManageServerAuthorization,
} from "../guild-management-authorization";
import { DiscordService } from "../service";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const REQUESTER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const LINKED_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const GUILD_ID = "223456789012345678";
const ACCOUNT_ID = "primary";

function authorizationHarness() {
	let member = true;
	let role: "ADMIN" | "GUEST" = "ADMIN";
	let worldId: UUID;
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		getWorld: async (requestedWorldId: UUID) =>
			requestedWorldId === worldId
				? {
						id: worldId,
						agentId: AGENT_ID,
						messageServerId: stringToUuid(GUILD_ID),
						metadata: {
							roles: { [LINKED_ID]: role },
							roleSources: { [LINKED_ID]: "manual" },
						},
					}
				: null,
		getRooms: async (requestedWorldId: UUID) =>
			requestedWorldId === worldId
				? [
						{
							id: ROOM_ID,
							worldId,
							agentId: AGENT_ID,
							source: "discord",
							type: "GROUP",
							serverId: GUILD_ID,
							messageServerId: stringToUuid(GUILD_ID),
						},
					]
				: [],
		getRoomsForParticipant: async (entityId: UUID) =>
			entityId === AGENT_ID || (entityId === LINKED_ID && member)
				? [ROOM_ID]
				: [],
		getService: (serviceType: string) =>
			serviceType === "relationships"
				? ({
						getVerifiedMemberEntityIds: async () => [LINKED_ID],
					} as never)
				: null,
		reportError: () => undefined,
	});
	worldId = createUniqueUuid(runtime, GUILD_ID);
	return {
		runtime,
		revokeMembership: () => {
			member = false;
		},
		revokeRole: () => {
			role = "GUEST";
		},
	};
}

async function errorCode(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
		throw new Error("expected authorization failure");
	} catch (error) {
		if (!(error instanceof ElizaError)) throw error;
		return error.code;
	}
}

describe("Discord guild-management authorization", () => {
	it("rejects display names instead of resolving them from the live guild cache", () => {
		const { runtime } = authorizationHarness();
		expect(() =>
			resolveDiscordManageServerDestination(
				runtime,
				{ serverId: "Production Guild" },
				ACCOUNT_ID,
			),
		).toThrowError(
			expect.objectContaining({ code: "DISCORD_MANAGE_SERVER_ID_REQUIRED" }),
		);
	});

	it("revalidates a verified linked ADMIN member at the connector boundary", async () => {
		const { runtime } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		const fresh = await revalidateDiscordManageServerAuthorization(
			runtime,
			authorization,
			ACCOUNT_ID,
			GUILD_ID,
		);
		expect(fresh).toMatchObject({
			requesterEntityId: REQUESTER_ID,
			authorizedEntityId: LINKED_ID,
			role: "ADMIN",
			accountId: ACCOUNT_ID,
			serverId: GUILD_ID,
		});
	});

	it("allows either configured account to use one shared durable guild room", async () => {
		const { runtime } = authorizationHarness();
		for (const accountId of [ACCOUNT_ID, "secondary"]) {
			const destination = resolveDiscordManageServerDestination(
				runtime,
				{ serverId: GUILD_ID },
				accountId,
			);
			const authorization = await authorizeManageServerDestination(
				runtime,
				REQUESTER_ID,
				destination,
			);
			const fresh = await revalidateDiscordManageServerAuthorization(
				runtime,
				authorization,
				accountId,
				GUILD_ID,
			);
			expect(fresh.accountId).toBe(accountId);
		}
	});

	it("fails when membership is revoked between core authorization and mutation", async () => {
		const { runtime, revokeMembership } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		revokeMembership();
		expect(
			await errorCode(() =>
				revalidateDiscordManageServerAuthorization(
					runtime,
					authorization,
					ACCOUNT_ID,
					GUILD_ID,
				),
			),
		).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
	});

	it("fails when the destination role is revoked before mutation", async () => {
		const { runtime, revokeRole } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		revokeRole();
		expect(
			await errorCode(() =>
				revalidateDiscordManageServerAuthorization(
					runtime,
					authorization,
					ACCOUNT_ID,
					GUILD_ID,
				),
			),
		).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
	});

	it("revalidates membership through the real service before provider discovery", async () => {
		const { runtime, revokeMembership } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		revokeMembership();
		let fetchCount = 0;
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime,
			defaultAccountId: ACCOUNT_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: {
					fetch: async () => {
						fetchCount += 1;
						return { id: GUILD_ID };
					},
				},
			}),
		}) as unknown as DiscordService;

		expect(
			await errorCode(() =>
				service.manageConnectorServer(runtime, {
					target: destination.target,
					operation: "create_channel",
					serverId: GUILD_ID,
					authorization,
					params: { name: "must-not-exist" },
					accountId: ACCOUNT_ID,
				}),
			),
		).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
		expect(fetchCount).toBe(0);
	});

	it("revalidates again after guild fetch so a race cannot mutate Discord", async () => {
		const { runtime, revokeRole } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		let mutationCount = 0;
		const empty = new Map();
		const guild = {
			id: GUILD_ID,
			name: "Destination B",
			members: {
				me: {
					id: "bot",
					permissions: { has: () => true },
					roles: {
						highest: { position: 100 },
						cache: empty,
						add: async () => undefined,
						remove: async () => undefined,
					},
					kick: async () => undefined,
					timeout: async () => undefined,
				},
				fetch: async () => {
					throw new Error("unexpected member lookup");
				},
			},
			roles: {
				everyone: { id: GUILD_ID },
				cache: empty,
				fetch: async () => null,
				create: async () => {
					throw new Error("unexpected role mutation");
				},
			},
			channels: {
				cache: empty,
				fetch: async () => null,
				create: async (options: Record<string, unknown>) => {
					mutationCount += 1;
					return {
						id: "423456789012345678",
						name: String(options.name),
					};
				},
			},
			bans: {
				create: async () => undefined,
				remove: async () => undefined,
			},
		} as unknown as ManageableGuild;
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: {
				...runtime,
				character: {
					...runtime.character,
					settings: {
						...runtime.character.settings,
						discord: { actions: { channels: true } },
					},
				},
			},
			defaultAccountId: ACCOUNT_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: {
					fetch: async () => {
						revokeRole();
						return guild;
					},
				},
			}),
		}) as unknown as DiscordService;

		expect(
			await errorCode(() =>
				service.manageConnectorServer(runtime, {
					target: destination.target,
					operation: "create_channel",
					serverId: GUILD_ID,
					authorization,
					params: { name: "must-not-exist" },
					accountId: ACCOUNT_ID,
				}),
			),
		).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
		expect(mutationCount).toBe(0);
	});

	it("rejects source, account, and guild provenance mismatches", async () => {
		const { runtime } = authorizationHarness();
		const destination = resolveDiscordManageServerDestination(
			runtime,
			{ serverId: GUILD_ID },
			ACCOUNT_ID,
		);
		const authorization = await authorizeManageServerDestination(
			runtime,
			REQUESTER_ID,
			destination,
		);
		for (const [accountId, guildId] of [
			["secondary", GUILD_ID],
			[ACCOUNT_ID, "323456789012345678"],
		] as const) {
			expect(
				await errorCode(() =>
					revalidateDiscordManageServerAuthorization(
						runtime,
						authorization,
						accountId,
						guildId,
					),
				),
			).toBe("DISCORD_MANAGE_SERVER_PROVENANCE_MISMATCH");
		}
		expect(() =>
			resolveDiscordManageServerDestination(
				runtime,
				{ target: { source: "telegram" }, serverId: GUILD_ID },
				ACCOUNT_ID,
			),
		).toThrowError(
			expect.objectContaining({
				code: "DISCORD_MANAGE_SERVER_SOURCE_MISMATCH",
			}),
		);
	});
});
