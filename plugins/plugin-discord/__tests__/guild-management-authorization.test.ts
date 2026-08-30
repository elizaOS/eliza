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
const CROSS_PLATFORM_ID = "00000000-0000-0000-0000-000000000005" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const GUILD_ID = "223456789012345678";
const ACCOUNT_ID = "primary";
const LIVE_USER_ID = "423456789012345678";

function liveGuildMembers(present = true) {
	return new Map(present ? [[LIVE_USER_ID, { id: LIVE_USER_ID }]] : []);
}

function authorizationHarness(
	options: { roleEntityId?: UUID; verifiedCluster?: UUID[] } = {},
) {
	const roleEntityId = options.roleEntityId ?? LINKED_ID;
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
							roles: { [roleEntityId]: role },
							roleSources: { [roleEntityId]: "manual" },
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
			entityId === AGENT_ID || (entityId === roleEntityId && member)
				? [ROOM_ID]
				: [],
		getService: (serviceType: string) =>
			serviceType === "relationships"
				? ({
						getVerifiedMemberEntityIds: async () =>
							options.verifiedCluster ?? [roleEntityId],
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

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Timed out waiting for ${label}.`)),
					2_000,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
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

	it("revalidates durable authorization after live membership lookup", async () => {
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
					roles: { highest: { position: 100 }, cache: empty },
				},
				fetch: async () => {
					revokeRole();
					return liveGuildMembers();
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
				create: async () => {
					mutationCount += 1;
					return { id: "623456789012345678", name: "must-not-exist" };
				},
			},
			bans: {
				create: async () => undefined,
				remove: async () => undefined,
			},
		} as unknown as ManageableGuild;
		const serviceRuntime = Object.assign(Object.create(runtime), {
			getSetting: () => undefined,
			character: {
				...runtime.character,
				settings: {
					...runtime.character.settings,
					discord: { actions: { channels: true } },
				},
			},
		});
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: serviceRuntime,
			defaultAccountId: ACCOUNT_ID,
			resolveDiscordEntityId: () => LINKED_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: { fetch: async () => guild },
			}),
		}) as unknown as DiscordService;

		expect(
			await errorCode(() =>
				service.manageConnectorServer(serviceRuntime, {
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

	it("accepts a live Discord member linked to a cross-platform authorized principal", async () => {
		const { runtime } = authorizationHarness({
			roleEntityId: CROSS_PLATFORM_ID,
			verifiedCluster: [REQUESTER_ID, CROSS_PLATFORM_ID, LINKED_ID],
		});
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
		const empty = new Map();
		const guild = {
			id: GUILD_ID,
			name: "Destination B",
			members: {
				me: {
					id: "bot",
					permissions: { has: () => true },
					roles: { highest: { position: 100 }, cache: empty },
				},
				fetch: async () => liveGuildMembers(),
			},
			roles: { everyone: { id: GUILD_ID }, cache: empty },
			channels: {
				cache: empty,
				fetch: async () => null,
				create: async () => ({ id: "723456789012345678", name: "linked" }),
			},
			bans: { create: async () => undefined, remove: async () => undefined },
		} as unknown as ManageableGuild;
		const serviceRuntime = Object.assign(Object.create(runtime), {
			getSetting: () => undefined,
			character: {
				...runtime.character,
				settings: {
					...runtime.character.settings,
					discord: { actions: { channels: true } },
				},
			},
		});
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: serviceRuntime,
			defaultAccountId: ACCOUNT_ID,
			resolveDiscordEntityId: () => LINKED_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: { fetch: async () => guild },
			}),
		}) as unknown as DiscordService;

		await expect(
			service.manageConnectorServer(serviceRuntime, {
				target: destination.target,
				operation: "create_channel",
				serverId: GUILD_ID,
				authorization,
				params: { name: "linked" },
				accountId: ACCOUNT_ID,
			}),
		).resolves.toMatchObject({ summary: expect.any(String) });
	});

	it("revalidates before every template mutation after authorization is revoked", async () => {
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
					roles: { highest: { position: 100 }, cache: empty },
				},
				fetch: async () => liveGuildMembers(),
			},
			roles: {
				everyone: { id: GUILD_ID },
				cache: empty,
				fetch: async () => null,
				create: async (options: Record<string, unknown>) => {
					mutationCount += 1;
					if (mutationCount === 1) revokeRole();
					return {
						id: `32345678901234567${mutationCount}`,
						name: String(options.name),
					};
				},
			},
			channels: {
				cache: empty,
				fetch: async () => null,
				create: async () => {
					throw new Error("unexpected channel mutation");
				},
			},
			bans: {
				create: async () => undefined,
				remove: async () => undefined,
			},
		} as unknown as ManageableGuild;
		const serviceRuntime = Object.assign(Object.create(runtime), {
			getSetting: () => undefined,
			getCache: async () => undefined,
			setCache: async () => undefined,
			character: {
				...runtime.character,
				settings: {
					...runtime.character.settings,
					discord: {
						actions: { channels: true, roles: true, permissions: true },
					},
				},
			},
		});
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: serviceRuntime,
			defaultAccountId: ACCOUNT_ID,
			resolveDiscordEntityId: () => LINKED_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: { fetch: async () => guild },
			}),
		}) as unknown as DiscordService;

		expect(
			await errorCode(() =>
				service.manageConnectorServer(serviceRuntime, {
					target: destination.target,
					operation: "apply_template",
					serverId: GUILD_ID,
					authorization,
					params: {
						templateSpec: {
							id: "revocation-race",
							roles: [
								{ key: "first", name: "First" },
								{ key: "second", name: "Second" },
							],
						},
					},
					accountId: ACCOUNT_ID,
				}),
			),
		).toBe("MANAGE_SERVER_DESTINATION_NOT_AUTHORIZED");
		expect(mutationCount).toBe(1);
	});

	it("stops template writes when live membership is revoked but durable membership remains", async () => {
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
		let liveMember = true;
		let mutationCount = 0;
		const empty = new Map();
		const guild = {
			id: GUILD_ID,
			name: "Destination B",
			members: {
				me: {
					id: "bot",
					permissions: { has: () => true },
					roles: { highest: { position: 100 }, cache: empty },
				},
				fetch: async () => liveGuildMembers(liveMember),
			},
			roles: {
				everyone: { id: GUILD_ID },
				cache: empty,
				fetch: async () => null,
				create: async (options: Record<string, unknown>) => {
					mutationCount += 1;
					liveMember = false;
					return {
						id: `52345678901234567${mutationCount}`,
						name: String(options.name),
					};
				},
			},
			channels: {
				cache: empty,
				fetch: async () => null,
				create: async () => {
					throw new Error("unexpected channel mutation");
				},
			},
			bans: {
				create: async () => undefined,
				remove: async () => undefined,
			},
		} as unknown as ManageableGuild;
		const serviceRuntime = Object.assign(Object.create(runtime), {
			getSetting: () => undefined,
			getCache: async () => undefined,
			setCache: async () => undefined,
			character: {
				...runtime.character,
				settings: {
					...runtime.character.settings,
					discord: {
						actions: { channels: true, roles: true, permissions: true },
					},
				},
			},
		});
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: serviceRuntime,
			defaultAccountId: ACCOUNT_ID,
			resolveDiscordEntityId: () => LINKED_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: { fetch: async () => guild },
			}),
		}) as unknown as DiscordService;

		expect(
			await errorCode(() =>
				service.manageConnectorServer(serviceRuntime, {
					target: destination.target,
					operation: "apply_template",
					serverId: GUILD_ID,
					authorization,
					params: {
						templateSpec: {
							id: "live-revocation-race",
							roles: [
								{ key: "first", name: "First" },
								{ key: "second", name: "Second" },
							],
						},
					},
					accountId: ACCOUNT_ID,
				}),
			),
		).toBe("DISCORD_MANAGE_SERVER_LIVE_MEMBERSHIP_REQUIRED");
		expect(mutationCount).toBe(1);
	});

	it("serializes concurrent template replays into one provider resource set", async () => {
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
		const cache = new Map<string, Record<string, string>>();
		const roles = new Map<string, Record<string, unknown>>();
		let mutationCount = 0;
		let crossBarrier!: () => void;
		const barrier = new Promise<void>((resolve) => {
			crossBarrier = resolve;
		});
		let releaseMutation!: () => void;
		const mutationRelease = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const empty = new Map();
		const guild = {
			id: GUILD_ID,
			name: "Destination B",
			members: {
				me: {
					id: "bot",
					permissions: { has: () => true },
					roles: { highest: { position: 100 }, cache: empty },
				},
				fetch: async () => liveGuildMembers(),
			},
			roles: {
				everyone: { id: GUILD_ID },
				cache: roles,
				fetch: async (id: string) => roles.get(id) ?? null,
				create: async (options: Record<string, unknown>) => {
					mutationCount += 1;
					const role = {
						id: "623456789012345678",
						name: String(options.name),
						managed: false,
						position: 1,
						color: 0,
						hoist: false,
						mentionable: false,
						permissions: { toArray: () => [] },
						edit: async () => undefined,
					};
					roles.set(role.id, role);
					crossBarrier();
					await mutationRelease;
					return role;
				},
			},
			channels: {
				cache: empty,
				fetch: async () => null,
				create: async () => {
					throw new Error("unexpected channel mutation");
				},
			},
			bans: {
				create: async () => undefined,
				remove: async () => undefined,
			},
		} as unknown as ManageableGuild;
		const serviceRuntime = Object.assign(Object.create(runtime), {
			getSetting: () => undefined,
			getCache: async (key: string) => cache.get(key),
			setCache: async (key: string, value: Record<string, string>) => {
				cache.set(key, value);
			},
			character: {
				...runtime.character,
				settings: {
					...runtime.character.settings,
					discord: {
						actions: { channels: true, roles: true, permissions: true },
					},
				},
			},
		});
		const service = Object.assign(Object.create(DiscordService.prototype), {
			runtime: serviceRuntime,
			defaultAccountId: ACCOUNT_ID,
			resolveDiscordEntityId: () => LINKED_ID,
			getClient: () => ({
				isReady: () => true,
				guilds: { fetch: async () => guild },
			}),
		}) as unknown as DiscordService;
		const params = {
			target: destination.target,
			operation: "apply_template",
			serverId: GUILD_ID,
			authorization,
			params: {
				templateSpec: {
					id: "concurrent-replay",
					roles: [{ key: "operator", name: "Operator" }],
				},
			},
			accountId: ACCOUNT_ID,
		};

		const first = service.manageConnectorServer(serviceRuntime, params);
		let second: ReturnType<typeof service.manageConnectorServer> | undefined;
		try {
			await bounded(barrier, "the first provider mutation barrier");
			second = service.manageConnectorServer(serviceRuntime, params);
			await Promise.resolve();
			await Promise.resolve();
			expect(mutationCount).toBe(1);
		} finally {
			releaseMutation();
		}
		if (!second) throw new Error("Concurrent replay did not start.");
		const [firstReceipt, secondReceipt] = await bounded(
			Promise.all([first, second]),
			"both serialized template reconciliations",
		);

		expect(mutationCount).toBe(1);
		expect(firstReceipt.data?.entries).toEqual(
			expect.arrayContaining([expect.objectContaining({ action: "created" })]),
		);
		expect(secondReceipt.data?.entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ action: "unchanged" }),
			]),
		);
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
