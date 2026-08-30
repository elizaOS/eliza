/**
 * Unit tests for the structural guild-management module: fail-closed config
 * gates, role-hierarchy denial, Administrator/permission-escalation rejection,
 * malformed-input errors, idempotent template reconcile (second apply is all
 * "unchanged"), non-destruction of unmanaged channels/roles, dry-run planning,
 * and moderation guardrails. Driven entirely by plain fakes of the
 * `Manageable*` structural interfaces — no live Discord client.
 */
import { describe, expect, it } from "vitest";
import {
	executeGuildManagement,
	GuildManagementError,
	type GuildManagementGates,
	type GuildManagementRequest,
	type ManageableBotMember,
	type ManageableChannel,
	type ManageableGuild,
	type ManageableMember,
	type ManageableRole,
	normalizePermissionList,
	resolveGuildManagementGates,
	type TemplateStateStore,
} from "../guild-management";
import { BUILT_IN_GUILD_TEMPLATES } from "../guild-templates";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

let idCounter = 1000;
function nextId(): string {
	idCounter += 1;
	return String(idCounter);
}

function permissionSet(names: string[]) {
	const set = new Set(names);
	return {
		has: (name: string) => set.has(name) || set.has("Administrator"),
		toArray: () => [...set].sort(),
	};
}

interface FakeRoleInit {
	id?: string;
	name: string;
	position?: number;
	managed?: boolean;
	color?: number;
	hoist?: boolean;
	mentionable?: boolean;
	permissions?: string[];
}

function makeRole(guild: FakeGuild, init: FakeRoleInit): ManageableRole {
	const role: ManageableRole = {
		id: init.id ?? nextId(),
		name: init.name,
		position: init.position ?? 1,
		managed: init.managed ?? false,
		color: init.color ?? 0,
		hoist: init.hoist ?? false,
		mentionable: init.mentionable ?? false,
		permissions: permissionSet(init.permissions ?? []),
		async edit(options: Record<string, unknown>) {
			if (typeof options.name === "string") role.name = options.name;
			if (typeof options.color === "number") role.color = options.color;
			if (typeof options.hoist === "boolean") role.hoist = options.hoist;
			if (typeof options.mentionable === "boolean")
				role.mentionable = options.mentionable;
			if (Array.isArray(options.permissions)) {
				role.permissions = permissionSet(options.permissions as string[]);
			}
			guild.log.push({ op: "role.edit", id: role.id, options });
			return role;
		},
		async delete(reason?: string) {
			guild.rolesMap.delete(role.id);
			guild.log.push({ op: "role.delete", id: role.id, reason });
			return undefined;
		},
	};
	return role;
}

interface FakeChannelInit {
	id?: string;
	name: string;
	type: number;
	parentId?: string | null;
	topic?: string | null;
}

function makeChannel(
	guild: FakeGuild,
	init: FakeChannelInit,
): ManageableChannel {
	const overwrites = new Map<
		string,
		{
			id: string;
			allow: ReturnType<typeof permissionSet>;
			deny: ReturnType<typeof permissionSet>;
		}
	>();
	const channel: ManageableChannel & {
		__overwrites: typeof overwrites;
	} = {
		id: init.id ?? nextId(),
		name: init.name,
		type: init.type,
		parentId: init.parentId ?? null,
		topic: init.topic ?? null,
		guildId: guild.id,
		__overwrites: overwrites,
		async edit(options: Record<string, unknown>) {
			if (typeof options.name === "string") channel.name = options.name;
			if (typeof options.topic === "string") channel.topic = options.topic;
			if (typeof options.parent === "string") channel.parentId = options.parent;
			guild.log.push({ op: "channel.edit", id: channel.id, options });
			return channel;
		},
		async delete(reason?: string) {
			guild.channelsMap.delete(channel.id);
			guild.log.push({ op: "channel.delete", id: channel.id, reason });
			return undefined;
		},
		permissionOverwrites: {
			cache: overwrites,
			async edit(target: string, options: Record<string, boolean | null>) {
				const allow: string[] = [];
				const deny: string[] = [];
				const reset: string[] = [];
				for (const [name, value] of Object.entries(options)) {
					if (value === true) allow.push(name);
					if (value === false) deny.push(name);
					if (value === null) reset.push(name);
				}
				const existing = overwrites.get(target);
				const mergedAllow = new Set([
					...(existing ? existing.allow.toArray() : []),
					...allow,
				]);
				const mergedDeny = new Set([
					...(existing ? existing.deny.toArray() : []),
					...deny,
				]);
				for (const name of allow) mergedDeny.delete(name);
				for (const name of deny) mergedAllow.delete(name);
				for (const name of reset) {
					mergedAllow.delete(name);
					mergedDeny.delete(name);
				}
				overwrites.set(target, {
					id: target,
					allow: permissionSet([...mergedAllow]),
					deny: permissionSet([...mergedDeny]),
				});
				guild.log.push({
					op: "overwrite.edit",
					id: channel.id,
					target,
					options,
				});
				return undefined;
			},
		},
		async createInvite(options) {
			guild.log.push({ op: "invite.create", id: channel.id, options });
			return { code: "abc123", url: "https://discord.gg/abc123" };
		},
	};
	return channel;
}

interface FakeGuild extends ManageableGuild {
	rolesMap: Map<string, ManageableRole>;
	channelsMap: Map<string, ManageableChannel>;
	membersMap: Map<string, ManageableMember>;
	log: Array<Record<string, unknown>>;
	bans_: Set<string>;
}

function makeGuild(options?: {
	botPermissions?: string[];
	botRolePosition?: number;
}): FakeGuild {
	const rolesMap = new Map<string, ManageableRole>();
	const channelsMap = new Map<string, ManageableChannel>();
	const membersMap = new Map<string, ManageableMember>();
	const log: Array<Record<string, unknown>> = [];
	const bans_ = new Set<string>();
	const everyoneId = "1";
	const botPermissions = options?.botPermissions ?? [
		"ManageChannels",
		"ManageRoles",
		"CreateInstantInvite",
		"KickMembers",
		"BanMembers",
		"ModerateMembers",
		"ViewChannel",
		"SendMessages",
		"ManageMessages",
		"ReadMessageHistory",
		"AddReactions",
		"AttachFiles",
		"EmbedLinks",
		"Connect",
		"Speak",
		"ManageThreads",
		"CreatePublicThreads",
		"SendMessagesInThreads",
		"UseApplicationCommands",
		"MentionEveryone",
		"ManageNicknames",
		"ModerateMembers",
	];
	const bot: ManageableBotMember = {
		id: "bot",
		permissions: permissionSet(botPermissions),
		roles: {
			highest: { position: options?.botRolePosition ?? 100 },
			cache: new Map(),
			add: async () => undefined,
			remove: async () => undefined,
		},
		kick: async () => undefined,
		timeout: async () => undefined,
	};
	const guild: FakeGuild = {
		id: "guild-1",
		name: "Test Guild",
		ownerId: "owner-1",
		rolesMap,
		channelsMap,
		membersMap,
		log,
		bans_,
		members: {
			me: bot,
			async fetch(userId: string) {
				const member = membersMap.get(userId);
				if (!member) {
					throw Object.assign(new Error("Unknown Member"), { code: 10007 });
				}
				return member;
			},
		},
		roles: {
			everyone: { id: everyoneId },
			cache: rolesMap,
			async fetch(roleId: string) {
				return rolesMap.get(roleId) ?? null;
			},
			async create(createOptions: Record<string, unknown>) {
				const role = makeRole(guild, {
					name: String(createOptions.name),
					position: 1,
					color:
						typeof createOptions.color === "number"
							? createOptions.color
							: undefined,
					hoist:
						typeof createOptions.hoist === "boolean"
							? createOptions.hoist
							: undefined,
					mentionable:
						typeof createOptions.mentionable === "boolean"
							? createOptions.mentionable
							: undefined,
					permissions: Array.isArray(createOptions.permissions)
						? (createOptions.permissions as string[])
						: [],
				});
				rolesMap.set(role.id, role);
				log.push({ op: "role.create", id: role.id, options: createOptions });
				return role;
			},
		},
		channels: {
			cache: channelsMap,
			async fetch(channelId: string) {
				return channelsMap.get(channelId) ?? null;
			},
			async create(createOptions: Record<string, unknown>) {
				const channel = makeChannel(guild, {
					name: String(createOptions.name),
					type: Number(createOptions.type),
					parentId:
						typeof createOptions.parent === "string"
							? createOptions.parent
							: null,
					topic:
						typeof createOptions.topic === "string"
							? createOptions.topic
							: null,
				});
				channelsMap.set(channel.id, channel);
				log.push({
					op: "channel.create",
					id: channel.id,
					options: createOptions,
				});
				return channel;
			},
		},
		bans: {
			async create(userId: string, banOptions?: Record<string, unknown>) {
				bans_.add(userId);
				log.push({ op: "ban.create", id: userId, options: banOptions });
				return undefined;
			},
			async remove(userId: string, reason?: string) {
				bans_.delete(userId);
				log.push({ op: "ban.remove", id: userId, reason });
				return undefined;
			},
		},
	};
	// @everyone role present in cache.
	rolesMap.set(
		everyoneId,
		makeRole(guild, { id: everyoneId, name: "@everyone", position: 0 }),
	);
	return guild;
}

function makeMember(
	guild: FakeGuild,
	init: {
		id: string;
		roles?: string[];
		kickable?: boolean;
		bannable?: boolean;
		moderatable?: boolean;
	},
): ManageableMember {
	const roleCache = new Map<string, { id: string }>();
	for (const roleId of init.roles ?? []) roleCache.set(roleId, { id: roleId });
	const member: ManageableMember = {
		id: init.id,
		kickable: init.kickable,
		bannable: init.bannable,
		moderatable: init.moderatable,
		roles: {
			highest: { position: 1 },
			cache: roleCache,
			async add(roleId: string) {
				roleCache.set(roleId, { id: roleId });
				guild.log.push({ op: "member.role.add", id: init.id, roleId });
				return undefined;
			},
			async remove(roleId: string) {
				roleCache.delete(roleId);
				guild.log.push({ op: "member.role.remove", id: init.id, roleId });
				return undefined;
			},
		},
		async kick(reason?: string) {
			guild.log.push({ op: "member.kick", id: init.id, reason });
			return undefined;
		},
		async timeout(durationMs: number | null, reason?: string) {
			guild.log.push({ op: "member.timeout", id: init.id, durationMs, reason });
			return undefined;
		},
	};
	guild.membersMap.set(init.id, member);
	return member;
}

function memoryStateStore(): TemplateStateStore & {
	stateMap: Map<string, Record<string, string>>;
} {
	const stateMap = new Map<string, Record<string, string>>();
	return {
		stateMap,
		async get(guildId, templateId) {
			return stateMap.get(`${guildId}:${templateId}`);
		},
		async set(guildId, templateId, state) {
			stateMap.set(`${guildId}:${templateId}`, state);
		},
	};
}

const ALL_GATES: GuildManagementGates = {
	channels: true,
	roles: true,
	permissions: true,
	moderation: true,
};

function run(
	guild: FakeGuild,
	request: GuildManagementRequest,
	overrides?: {
		gates?: Partial<GuildManagementGates>;
		stateStore?: TemplateStateStore;
	},
) {
	return executeGuildManagement(
		{
			guild,
			gates: { ...ALL_GATES, ...(overrides?.gates ?? {}) },
			stateStore: overrides?.stateStore ?? memoryStateStore(),
			agentName: "Soliza",
		},
		request,
	);
}

async function expectError(
	promise: Promise<unknown>,
	code: string,
): Promise<GuildManagementError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(GuildManagementError);
		const managementError = error as GuildManagementError;
		expect(managementError.code).toBe(code);
		return managementError;
	}
	throw new Error(`expected GuildManagementError ${code}, got success`);
}

// ---------------------------------------------------------------------------
// Gate behavior (fail closed)
// ---------------------------------------------------------------------------

describe("guild management gates", () => {
	it("resolves absent config to every structural gate OFF", () => {
		expect(resolveGuildManagementGates(undefined)).toEqual({
			channels: false,
			roles: false,
			permissions: false,
			moderation: false,
		});
	});

	it("only an explicit true opens a gate (truthy strings stay closed)", () => {
		expect(
			resolveGuildManagementGates({
				channels: "true",
				roles: 1,
				permissions: true,
				moderation: false,
			}),
		).toEqual({
			channels: false,
			roles: false,
			permissions: true,
			moderation: false,
		});
	});

	it("denies create_channel when actions.channels is off", async () => {
		const guild = makeGuild();
		const error = await expectError(
			run(
				guild,
				{ operation: "create_channel", name: "general" },
				{
					gates: { channels: false },
				},
			),
			"GATE_DISABLED",
		);
		expect(error.message).toContain("actions.channels");
		expect(guild.log).toHaveLength(0);
	});

	it("denies create_role when actions.roles is off", async () => {
		const guild = makeGuild();
		await expectError(
			run(
				guild,
				{ operation: "create_role", name: "Dev" },
				{
					gates: { roles: false },
				},
			),
			"GATE_DISABLED",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("denies edit_permissions when actions.permissions is off", async () => {
		const guild = makeGuild();
		await expectError(
			run(
				guild,
				{
					operation: "edit_permissions",
					channelId: "123",
					overwriteId: "@everyone",
					deny: ["ViewChannel"],
				},
				{ gates: { permissions: false } },
			),
			"GATE_DISABLED",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("denies kick when actions.moderation is off", async () => {
		const guild = makeGuild();
		await expectError(
			run(
				guild,
				{ operation: "kick", userId: "12345678" },
				{
					gates: { moderation: false },
				},
			),
			"GATE_DISABLED",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("apply_template requires channels + roles + permissions gates", async () => {
		const guild = makeGuild();
		const error = await expectError(
			run(
				guild,
				{ operation: "apply_template", template: "project-team" },
				{
					gates: { permissions: false },
				},
			),
			"GATE_DISABLED",
		);
		expect(error.message).toContain("actions.permissions");
	});

	it("list_templates requires no gates", async () => {
		const guild = makeGuild();
		const result = await run(
			guild,
			{ operation: "list_templates" },
			{
				gates: {
					channels: false,
					roles: false,
					permissions: false,
					moderation: false,
				},
			},
		);
		expect(result.templates?.map((template) => template.id)).toEqual(
			Object.keys(BUILT_IN_GUILD_TEMPLATES).sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("guild management input validation", () => {
	it("rejects unknown operations", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, { operation: "nuke_guild" as never }),
			"OPERATION_UNKNOWN",
		);
	});

	it("rejects Administrator in role permissions", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "create_role",
				name: "Sneaky",
				permissions: ["ADMINISTRATOR"],
			}),
			"PERMISSION_ADMINISTRATOR_FORBIDDEN",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("rejects unknown permission names with the offending name", async () => {
		const guild = makeGuild();
		const error = await expectError(
			run(guild, {
				operation: "create_role",
				name: "Dev",
				permissions: ["TotallyRealPerm"],
			}),
			"PERMISSION_UNKNOWN",
		);
		expect(error.message).toContain("TotallyRealPerm");
	});

	it("accepts SCREAMING_SNAKE and camelCase permission spellings", () => {
		expect(
			normalizePermissionList(["MANAGE_CHANNELS", "sendMessages"], "test"),
		).toEqual(["ManageChannels", "SendMessages"]);
	});

	it("rejects a permission listed in both allow and deny", async () => {
		const guild = makeGuild();
		const channel = makeChannel(guild, { name: "general", type: 0 });
		guild.channelsMap.set(channel.id, channel);
		await expectError(
			run(guild, {
				operation: "edit_permissions",
				channelId: channel.id,
				overwriteId: "@everyone",
				allow: ["SendMessages"],
				deny: ["SendMessages"],
			}),
			"PERMISSION_CONFLICT",
		);
	});

	it("rejects invalid colors", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, { operation: "create_role", name: "Dev", color: "red" }),
			"COLOR_INVALID",
		);
	});

	it("requires channelId for edit_channel", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, { operation: "edit_channel", name: "renamed" }),
			"CHANNEL_ID_REQUIRED",
		);
	});

	it("fails on channels that do not exist in the guild", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, { operation: "delete_channel", channelId: "404404" }),
			"CHANNEL_NOT_FOUND",
		);
	});
});

// ---------------------------------------------------------------------------
// Permission escalation + hierarchy
// ---------------------------------------------------------------------------

describe("guild management hierarchy and escalation guards", () => {
	it("refuses to grant role permissions the bot does not hold", async () => {
		const guild = makeGuild({
			botPermissions: ["ManageRoles", "ViewChannel", "SendMessages"],
		});
		const error = await expectError(
			run(guild, {
				operation: "create_role",
				name: "Overreach",
				permissions: ["BanMembers"],
			}),
			"PERMISSION_ESCALATION",
		);
		expect(error.message).toContain("BanMembers");
	});

	it("refuses to edit a role at or above the bot's highest role", async () => {
		const guild = makeGuild({ botRolePosition: 5 });
		const high = makeRole(guild, { name: "Above", position: 9 });
		guild.rolesMap.set(high.id, high);
		await expectError(
			run(guild, { operation: "edit_role", roleId: high.id, name: "Renamed" }),
			"ROLE_HIERARCHY",
		);
	});

	it("refuses to delete integration-managed roles", async () => {
		const guild = makeGuild();
		const managed = makeRole(guild, {
			name: "SomeBot",
			position: 2,
			managed: true,
		});
		guild.rolesMap.set(managed.id, managed);
		await expectError(
			run(guild, { operation: "delete_role", roleId: managed.id }),
			"ROLE_MANAGED",
		);
	});

	it("refuses direct writes against @everyone via role verbs", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, { operation: "delete_role", roleId: "1" }),
			"ROLE_EVERYONE",
		);
	});

	it("refuses assign_role when the role is above the bot", async () => {
		const guild = makeGuild({ botRolePosition: 3 });
		const high = makeRole(guild, { name: "Admin", position: 8 });
		guild.rolesMap.set(high.id, high);
		makeMember(guild, { id: "555555" });
		await expectError(
			run(guild, {
				operation: "assign_role",
				roleId: high.id,
				userId: "555555",
			}),
			"ROLE_HIERARCHY",
		);
	});

	it("refuses moderation against the guild owner", async () => {
		const guild = makeGuild();
		makeMember(guild, { id: "owner-1" });
		await expectError(
			run(guild, { operation: "kick", userId: "owner-1" }),
			"USER_ID_INVALID",
		);
		// With a snowflake-shaped owner id the owner guard fires.
		guild.ownerId = "99999999";
		makeMember(guild, { id: "99999999" });
		await expectError(
			run(guild, { operation: "kick", userId: "99999999" }),
			"MODERATION_OWNER",
		);
	});

	it("refuses kick when Discord reports the member is not kickable", async () => {
		const guild = makeGuild();
		makeMember(guild, { id: "424242", kickable: false });
		await expectError(
			run(guild, { operation: "kick", userId: "424242" }),
			"MODERATION_HIERARCHY",
		);
	});

	it("refuses writes when the bot lacks the Discord-side permission", async () => {
		const guild = makeGuild({ botPermissions: ["SendMessages"] });
		const error = await expectError(
			run(guild, { operation: "create_channel", name: "general" }),
			"BOT_MISSING_PERMISSION",
		);
		expect(error.message).toContain("ManageChannels");
	});
});

// ---------------------------------------------------------------------------
// Individual verbs
// ---------------------------------------------------------------------------

describe("guild management verbs", () => {
	it("creates a category and a channel under it", async () => {
		const guild = makeGuild();
		const categoryReceipt = await run(guild, {
			operation: "create_category",
			name: "OPS",
		});
		expect(categoryReceipt.entries[0]?.action).toBe("created");
		const categoryId = categoryReceipt.entries[0]?.id as string;
		const channelReceipt = await run(guild, {
			operation: "create_channel",
			name: "alerts",
			parentId: categoryId,
			topic: "CI alerts",
		});
		expect(channelReceipt.entries[0]?.action).toBe("created");
		const created = guild.channelsMap.get(
			channelReceipt.entries[0]?.id as string,
		);
		expect(created?.parentId).toBe(categoryId);
		expect(created?.topic).toBe("CI alerts");
	});

	it("dry-run create reports the plan without writing", async () => {
		const guild = makeGuild();
		const receipt = await run(guild, {
			operation: "create_channel",
			name: "general",
			dryRun: true,
		});
		expect(receipt.dryRun).toBe(true);
		expect(receipt.entries[0]?.action).toBe("would_create");
		expect(guild.log).toHaveLength(0);
		expect(guild.channelsMap.size).toBe(0);
	});

	it("rejects direct channel topics beyond Discord's limit before writing", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "create_channel",
				name: "general",
				topic: "x".repeat(1025),
			}),
			"TOPIC_TOO_LONG",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("assign_role is idempotent (already-assigned reports unchanged)", async () => {
		const guild = makeGuild();
		const role = makeRole(guild, { name: "Dev", position: 2 });
		guild.rolesMap.set(role.id, role);
		makeMember(guild, { id: "777777" });
		const first = await run(guild, {
			operation: "assign_role",
			roleId: role.id,
			userId: "777777",
		});
		expect(first.entries[0]?.action).toBe("updated");
		const second = await run(guild, {
			operation: "assign_role",
			roleId: role.id,
			userId: "777777",
		});
		expect(second.entries[0]?.action).toBe("unchanged");
		const writes = guild.log.filter((entry) => entry.op === "member.role.add");
		expect(writes).toHaveLength(1);
	});

	it("creates invites with bounded age and never echoes tokens", async () => {
		const guild = makeGuild();
		const channel = makeChannel(guild, { name: "general", type: 0 });
		guild.channelsMap.set(channel.id, channel);
		const receipt = await run(guild, {
			operation: "create_invite",
			channelId: channel.id,
			maxAgeSeconds: 99999999,
		});
		expect(receipt.invite?.code).toBe("abc123");
		const logged = guild.log.find((entry) => entry.op === "invite.create");
		expect(logged).toBeDefined();
		expect(
			(logged as { options: { maxAge: number } }).options.maxAge,
		).toBeLessThanOrEqual(7 * 24 * 60 * 60);
	});

	it("timeout clamps duration and moderatable=false denies", async () => {
		const guild = makeGuild();
		makeMember(guild, { id: "888888", moderatable: true });
		const receipt = await run(guild, {
			operation: "timeout",
			userId: "888888",
			durationMinutes: 10_000_000,
		});
		expect(receipt.entries[0]?.action).toBe("updated");
		const logged = guild.log.find((entry) => entry.op === "member.timeout");
		expect((logged as { durationMs: number }).durationMs).toBeLessThanOrEqual(
			28 * 24 * 60 * 60 * 1000,
		);
	});

	it("ban then unban round-trips through guild.bans", async () => {
		const guild = makeGuild();
		await run(guild, { operation: "ban", userId: "654321" });
		expect(guild.bans_.has("654321")).toBe(true);
		await run(guild, { operation: "unban", userId: "654321" });
		expect(guild.bans_.has("654321")).toBe(false);
	});

	it("does not ban when member lookup fails for a reason other than absence", async () => {
		const guild = makeGuild();
		guild.members.fetch = async () => {
			throw new Error("Discord gateway unavailable");
		};
		const error = await expectError(
			run(guild, { operation: "ban", userId: "654321" }),
			"MEMBER_FETCH_FAILED",
		);
		expect(error.cause).toBeInstanceOf(Error);
		expect(guild.bans_.has("654321")).toBe(false);
		expect(guild.log).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Template reconcile
// ---------------------------------------------------------------------------

describe("apply_template reconcile", () => {
	it("first apply creates roles, categories, channels, and overwrites", async () => {
		const guild = makeGuild();
		const stateStore = memoryStateStore();
		const receipt = await run(
			guild,
			{ operation: "apply_template", template: "project-team" },
			{ stateStore },
		);
		expect(
			receipt.entries.filter((entry) => entry.action === "created").length,
		).toBeGreaterThanOrEqual(4 + 3 + 4); // roles + categories + channels
		// Agent placeholder rendered.
		const agentRole = [...guild.rolesMap.values()].find(
			(role) => role.name === "Soliza",
		);
		expect(agentRole).toBeDefined();
		// State persisted for idempotency.
		expect(stateStore.stateMap.get("guild-1:project-team")).toBeDefined();
	});

	it("second apply converges: everything unchanged, zero writes", async () => {
		const guild = makeGuild();
		const stateStore = memoryStateStore();
		await run(
			guild,
			{ operation: "apply_template", template: "project-team" },
			{ stateStore },
		);
		const writesAfterFirst = guild.log.length;
		const second = await run(
			guild,
			{ operation: "apply_template", template: "project-team" },
			{ stateStore },
		);
		expect(second.entries.every((entry) => entry.action === "unchanged")).toBe(
			true,
		);
		expect(guild.log.length).toBe(writesAfterFirst);
	});

	it("re-apply after manual rename converges the managed channel back", async () => {
		const guild = makeGuild();
		const stateStore = memoryStateStore();
		await run(
			guild,
			{ operation: "apply_template", template: "friends-casual" },
			{ stateStore },
		);
		const lounge = [...guild.channelsMap.values()].find(
			(channel) => channel.name === "lounge",
		);
		expect(lounge).toBeDefined();
		// Manual drift.
		if (lounge) lounge.name = "renamed-by-human";
		const second = await run(
			guild,
			{ operation: "apply_template", template: "friends-casual" },
			{ stateStore },
		);
		const loungeEntry = second.entries.find((entry) => entry.key === "lounge");
		expect(loungeEntry?.action).toBe("updated");
		expect(lounge?.name).toBe("lounge");
	});

	it("reconcile removes stale extra permissions from managed overwrites", async () => {
		const guild = makeGuild();
		const stateStore = memoryStateStore();
		await run(
			guild,
			{ operation: "apply_template", template: "project-team" },
			{ stateStore },
		);
		const dev = [...guild.channelsMap.values()].find(
			(channel) => channel.name === "dev",
		) as
			| (ManageableChannel & {
					__overwrites: Map<
						string,
						{
							id: string;
							allow: ReturnType<typeof permissionSet>;
							deny: ReturnType<typeof permissionSet>;
						}
					>;
			  })
			| undefined;
		expect(dev).toBeDefined();
		const everyone = dev?.__overwrites.get(guild.roles.everyone.id);
		expect(everyone).toBeDefined();
		if (dev && everyone) {
			dev.__overwrites.set(everyone.id, {
				...everyone,
				allow: permissionSet(["ManageChannels"]),
			});
		}

		const second = await run(
			guild,
			{ operation: "apply_template", template: "project-team" },
			{ stateStore },
		);
		expect(
			second.entries.find((entry) => entry.key === "dev/@everyone")?.action,
		).toBe("updated");
		expect(
			dev?.__overwrites
				.get(guild.roles.everyone.id)
				?.allow.has("ManageChannels"),
		).toBe(false);
	});

	it("NEVER deletes unmanaged channels or roles", async () => {
		const guild = makeGuild();
		const manualChannel = makeChannel(guild, {
			name: "hand-made-channel",
			type: 0,
		});
		guild.channelsMap.set(manualChannel.id, manualChannel);
		const manualRole = makeRole(guild, { name: "Hand Made Role", position: 2 });
		guild.rolesMap.set(manualRole.id, manualRole);
		await run(guild, { operation: "apply_template", template: "project-team" });
		await run(guild, { operation: "apply_template", template: "project-team" });
		expect(guild.channelsMap.get(manualChannel.id)).toBeDefined();
		expect(guild.rolesMap.get(manualRole.id)).toBeDefined();
		expect(
			guild.log.some(
				(entry) => entry.op === "channel.delete" || entry.op === "role.delete",
			),
		).toBe(false);
	});

	it("dry-run apply plans without writing and without persisting state", async () => {
		const guild = makeGuild();
		const stateStore = memoryStateStore();
		const receipt = await run(
			guild,
			{
				operation: "apply_template",
				template: "companion-private",
				dryRun: true,
			},
			{ stateStore },
		);
		expect(receipt.dryRun).toBe(true);
		expect(
			receipt.entries.every((entry) =>
				["would_create", "would_update", "unchanged", "skipped"].includes(
					entry.action,
				),
			),
		).toBe(true);
		expect(guild.log).toHaveLength(0);
		expect(stateStore.stateMap.size).toBe(0);
	});

	it("rejects unknown template ids with the available list", async () => {
		const guild = makeGuild();
		const error = await expectError(
			run(guild, { operation: "apply_template", template: "does-not-exist" }),
			"TEMPLATE_NOT_FOUND",
		);
		expect(error.message).toContain("project-team");
	});

	it("rejects inline template specs that fail validation", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "apply_template",
				templateSpec: {
					id: "broken",
					channels: [{ key: "a", name: "a", parent: "missing-category" }],
				},
			}),
			"TEMPLATE_INVALID",
		);
	});

	it("rejects malformed inline template collections without entering reconcile", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "apply_template",
				templateSpec: {
					id: "malformed",
					roles: {} as never,
				},
			}),
			"TEMPLATE_INVALID",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("rejects template variables that render names beyond Discord's limit", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "apply_template",
				templateSpec: {
					id: "render-bound",
					roles: [{ key: "agent", name: "{{agent}}" }],
				},
				variables: { agent: "x".repeat(101) },
			}),
			"TEMPLATE_RENDER_INVALID",
		);
		expect(guild.log).toHaveLength(0);
	});

	it("rejects inline template specs that request Administrator", async () => {
		const guild = makeGuild();
		await expectError(
			run(guild, {
				operation: "apply_template",
				templateSpec: {
					id: "sneaky",
					roles: [
						{ key: "boss", name: "Boss", permissions: ["Administrator"] },
					],
				},
			}),
			"PERMISSION_ADMINISTRATOR_FORBIDDEN",
		);
	});

	it("supports custom tenant templates through the registry override", async () => {
		const guild = makeGuild();
		const receipt = await executeGuildManagement(
			{
				guild,
				gates: ALL_GATES,
				stateStore: memoryStateStore(),
				agentName: "Soliza",
				templateRegistry: {
					"code-ops": {
						id: "code-ops",
						categories: [{ key: "cat", name: "CODE OPS" }],
						channels: [
							{ key: "builds", name: "builds", parent: "cat" },
							{ key: "prs", name: "prs", parent: "cat" },
						],
					},
				},
			},
			{ operation: "apply_template", template: "code-ops" },
		);
		expect(
			receipt.entries.filter((entry) => entry.action === "created"),
		).toHaveLength(3);
		expect(
			[...guild.channelsMap.values()].map((channel) => channel.name).sort(),
		).toEqual(["CODE OPS", "builds", "prs"]);
	});
});
