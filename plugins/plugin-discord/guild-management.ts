/**
 * Structural guild management for the Discord connector: create/edit/delete
 * channels, categories, and roles, permission-overwrite editing, member role
 * assignment, invites, moderation verbs, and an idempotent non-destructive
 * template reconcile (`apply_template`).
 *
 * Security model (fail closed):
 * - Every write sits behind the `actions.channels`, `actions.roles`,
 *   `actions.permissions`, or `actions.moderation` config gates. For these
 *   STRUCTURAL operations an absent gate means OFF — the deployment must
 *   explicitly opt in.
 * - Role and member operations validate Discord role hierarchy: the bot can
 *   only touch roles strictly below its own highest role, and only members it
 *   can manage.
 * - The `Administrator` permission can never be granted through this surface,
 *   in any role or overwrite, and requested role permissions must be a subset
 *   of what the bot itself holds.
 * - Template reconcile matches objects by stable template key (persisted
 *   key->snowflake map, exact-name fallback), converges on re-apply, and
 *   NEVER deletes channels or roles it does not manage. Deletion only happens
 *   through the explicit, gated `delete_channel` / `delete_role` verbs.
 *
 * The module operates on narrow structural interfaces (`ManageableGuild` et
 * al) so unit tests can drive it with plain fakes; `service.ts` adapts the
 * live discord.js `Guild` to it.
 */

import { ElizaError } from "@elizaos/core";
import { ChannelType, PermissionsBitField } from "discord.js";
import {
	BUILT_IN_GUILD_TEMPLATES,
	GUILD_TEMPLATE_LIMITS,
	type GuildTemplate,
	type GuildTemplateChannel,
	type GuildTemplateChannelType,
	type GuildTemplateOverwrite,
	renderTemplateString,
	validateGuildTemplate,
} from "./guild-templates";

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export interface GuildManagementGates {
	channels: boolean;
	roles: boolean;
	permissions: boolean;
	moderation: boolean;
}

/**
 * Structural management gates fail closed: only an explicit `true` opens a
 * gate. (`DiscordActionConfig` documents `default: true` for the lightweight
 * messaging toggles; the structural surface is deliberately stricter.)
 */
export function resolveGuildManagementGates(
	actions: Record<string, unknown> | undefined,
): GuildManagementGates {
	return {
		channels: actions?.channels === true,
		roles: actions?.roles === true,
		permissions: actions?.permissions === true,
		moderation: actions?.moderation === true,
	};
}

export const GUILD_MANAGEMENT_OPERATIONS = [
	"create_category",
	"create_channel",
	"edit_channel",
	"delete_channel",
	"create_role",
	"edit_role",
	"delete_role",
	"edit_permissions",
	"assign_role",
	"remove_role",
	"create_invite",
	"kick",
	"ban",
	"unban",
	"timeout",
	"list_templates",
	"apply_template",
] as const;

export type GuildManagementOperation =
	(typeof GUILD_MANAGEMENT_OPERATIONS)[number];

/** Gates each operation requires. ALL listed gates must be open. */
export const OPERATION_GATES: Record<
	GuildManagementOperation,
	Array<keyof GuildManagementGates>
> = {
	create_category: ["channels"],
	create_channel: ["channels"],
	edit_channel: ["channels"],
	delete_channel: ["channels"],
	create_role: ["roles"],
	edit_role: ["roles"],
	delete_role: ["roles"],
	edit_permissions: ["permissions"],
	assign_role: ["roles"],
	remove_role: ["roles"],
	create_invite: ["channels"],
	kick: ["moderation"],
	ban: ["moderation"],
	unban: ["moderation"],
	timeout: ["moderation"],
	list_templates: [],
	apply_template: ["channels", "roles", "permissions"],
};

export function normalizeGuildManagementOperation(
	value: unknown,
): GuildManagementOperation | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, "_");
	return (GUILD_MANAGEMENT_OPERATIONS as readonly string[]).includes(normalized)
		? (normalized as GuildManagementOperation)
		: undefined;
}

// ---------------------------------------------------------------------------
// Structural interfaces (fake-able subset of discord.js)
// ---------------------------------------------------------------------------

export interface ManageablePermissionSet {
	has(permission: string): boolean;
	toArray?(): string[];
}

export interface ManageableRole {
	id: string;
	name: string;
	position: number;
	/** Integration-managed roles (bot roles, boosts) are never touched. */
	managed?: boolean;
	color?: number;
	hoist?: boolean;
	mentionable?: boolean;
	permissions: ManageablePermissionSet & { toArray?(): string[] };
	/** discord.js style: audit-log `reason` travels inside options. */
	edit(options: Record<string, unknown>): Promise<ManageableRole>;
	delete(reason?: string): Promise<unknown>;
}

export interface ManageableOverwrite {
	id: string;
	allow: ManageablePermissionSet;
	deny: ManageablePermissionSet;
}

export interface ManageableChannel {
	id: string;
	name: string;
	type: number;
	parentId?: string | null;
	topic?: string | null;
	guildId?: string;
	/** discord.js style: audit-log `reason` travels inside options. */
	edit(options: Record<string, unknown>): Promise<ManageableChannel>;
	delete(reason?: string): Promise<unknown>;
	permissionOverwrites?: {
		cache: ReadonlyMap<string, ManageableOverwrite>;
		edit(
			target: string,
			options: Record<string, boolean | null>,
			extra?: Record<string, unknown>,
		): Promise<unknown>;
	};
	createInvite?(options: {
		maxAge?: number;
		maxUses?: number;
		unique?: boolean;
		reason?: string;
	}): Promise<{ code: string; url?: string }>;
}

export interface ManageableMember {
	id: string;
	kickable?: boolean;
	bannable?: boolean;
	moderatable?: boolean;
	roles: {
		highest: { position: number };
		cache: ReadonlyMap<string, { id: string }>;
		add(roleId: string, reason?: string): Promise<unknown>;
		remove(roleId: string, reason?: string): Promise<unknown>;
	};
	kick(reason?: string): Promise<unknown>;
	timeout(durationMs: number | null, reason?: string): Promise<unknown>;
}

export interface ManageableBotMember extends ManageableMember {
	permissions: ManageablePermissionSet;
}

export interface ManageableGuild {
	id: string;
	name: string;
	ownerId?: string;
	members: {
		me: ManageableBotMember | null;
		fetch(userId: string): Promise<ManageableMember>;
	};
	roles: {
		everyone: { id: string };
		cache: ReadonlyMap<string, ManageableRole>;
		fetch(roleId: string): Promise<ManageableRole | null>;
		create(options: Record<string, unknown>): Promise<ManageableRole>;
	};
	channels: {
		cache: ReadonlyMap<string, ManageableChannel>;
		fetch(channelId: string): Promise<ManageableChannel | null>;
		create(options: Record<string, unknown>): Promise<ManageableChannel>;
	};
	bans: {
		create(userId: string, options?: Record<string, unknown>): Promise<unknown>;
		remove(userId: string, reason?: string): Promise<unknown>;
	};
}

/** Persisted template key->snowflake map, one record per guild+template. */
export interface TemplateStateStore {
	get(
		guildId: string,
		templateId: string,
	): Promise<Record<string, string> | undefined>;
	set(
		guildId: string,
		templateId: string,
		state: Record<string, string>,
	): Promise<void>;
}

export interface GuildManagementContext {
	guild: ManageableGuild;
	gates: GuildManagementGates;
	stateStore: TemplateStateStore;
	templateRegistry?: Record<string, GuildTemplate>;
	/** Rendered into `{{agent}}` template placeholders. */
	agentName?: string;
	/** Audit-log reason prefix for every write. */
	reasonPrefix?: string;
}

// ---------------------------------------------------------------------------
// Request / receipt shapes
// ---------------------------------------------------------------------------

export interface GuildManagementRequest {
	operation: GuildManagementOperation;
	guildId?: string;
	channelId?: string;
	/** Category (parent) channel id or template category name for creation. */
	parentId?: string;
	roleId?: string;
	userId?: string;
	name?: string;
	topic?: string;
	channelType?: string;
	color?: string;
	hoist?: boolean;
	mentionable?: boolean;
	permissions?: string[];
	allow?: string[];
	deny?: string[];
	/** Overwrite subject for edit_permissions: role id, user id, or "@everyone". */
	overwriteId?: string;
	reason?: string;
	durationMinutes?: number;
	deleteMessageSeconds?: number;
	maxAgeSeconds?: number;
	maxUses?: number;
	unique?: boolean;
	template?: string;
	templateSpec?: GuildTemplate;
	variables?: Record<string, string>;
	dryRun?: boolean;
}

export type ReceiptAction =
	| "created"
	| "updated"
	| "deleted"
	| "unchanged"
	| "would_create"
	| "would_update"
	| "skipped";

export interface ReceiptEntry {
	kind:
		| "role"
		| "category"
		| "channel"
		| "overwrite"
		| "member_role"
		| "invite"
		| "member";
	action: ReceiptAction;
	name?: string;
	key?: string;
	id?: string;
	reason?: string;
}

export interface GuildManagementReceipt {
	operation: GuildManagementOperation;
	guildId: string;
	guildName?: string;
	dryRun: boolean;
	entries: ReceiptEntry[];
	invite?: { code: string; url?: string };
	templates?: Array<{ id: string; description?: string }>;
	summary: string;
}

export class GuildManagementError extends ElizaError {
	override readonly name = "GuildManagementError";
	constructor(code: string, message: string, cause?: unknown) {
		super(message, {
			code,
			...(cause !== undefined ? { cause } : {}),
		});
	}
}

// ---------------------------------------------------------------------------
// Permission-name handling
// ---------------------------------------------------------------------------

const PERMISSION_FLAG_NAMES = new Set(Object.keys(PermissionsBitField.Flags));

/** "MANAGE_CHANNELS" | "manageChannels" | "ManageChannels" -> "ManageChannels". */
export function normalizePermissionName(raw: string): string | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	if (PERMISSION_FLAG_NAMES.has(trimmed)) return trimmed;
	const pascal = trimmed
		.toLowerCase()
		.split(/[_\s-]+/)
		.map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
		.join("");
	if (PERMISSION_FLAG_NAMES.has(pascal)) return pascal;
	// Allow camelCase input ("manageChannels").
	const upperFirst = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
	if (PERMISSION_FLAG_NAMES.has(upperFirst)) return upperFirst;
	return undefined;
}

/**
 * Normalizes a permission list, rejecting unknown names and the Administrator
 * bypass. Deterministic (sorted) output.
 */
export function normalizePermissionList(
	values: string[] | undefined,
	label: string,
): string[] {
	if (!values || values.length === 0) return [];
	if (values.length > GUILD_TEMPLATE_LIMITS.maxPermissionEntries) {
		throw new GuildManagementError(
			"PERMISSIONS_TOO_MANY",
			`${label} lists ${values.length} permissions; the maximum is ${GUILD_TEMPLATE_LIMITS.maxPermissionEntries}.`,
		);
	}
	const normalized = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") {
			throw new GuildManagementError(
				"PERMISSION_INVALID",
				`${label} contains a non-string permission entry.`,
			);
		}
		const name = normalizePermissionName(value);
		if (!name) {
			throw new GuildManagementError(
				"PERMISSION_UNKNOWN",
				`${label} contains unknown Discord permission "${value}".`,
			);
		}
		if (name === "Administrator") {
			throw new GuildManagementError(
				"PERMISSION_ADMINISTRATOR_FORBIDDEN",
				`${label} requests Administrator; granting the Administrator bypass through guild management is not allowed.`,
			);
		}
		normalized.add(name);
	}
	return [...normalized].sort();
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

function requireGates(
	gates: GuildManagementGates,
	operation: GuildManagementOperation,
): void {
	const required = OPERATION_GATES[operation];
	const closed = required.filter((gate) => gates[gate] !== true);
	if (closed.length > 0) {
		throw new GuildManagementError(
			"GATE_DISABLED",
			`Discord ${operation} is disabled: config gate${closed.length > 1 ? "s" : ""} ` +
				`${closed.map((gate) => `actions.${gate}`).join(", ")} ` +
				"must be explicitly enabled in the Discord connector settings.",
		);
	}
}

function requireBotMember(guild: ManageableGuild): ManageableBotMember {
	const me = guild.members.me;
	if (!me) {
		throw new GuildManagementError(
			"BOT_MEMBER_UNAVAILABLE",
			`The bot's own member record for guild ${guild.id} is unavailable.`,
		);
	}
	return me;
}

function requireBotPermission(
	guild: ManageableGuild,
	permission: string,
	operation: string,
): ManageableBotMember {
	const me = requireBotMember(guild);
	if (!me.permissions.has(permission)) {
		throw new GuildManagementError(
			"BOT_MISSING_PERMISSION",
			`The bot lacks the ${permission} permission in guild "${guild.name}" required for ${operation}. Re-invite the bot with a permission set that includes ${permission}.`,
		);
	}
	return me;
}

/** Bot may only manage roles strictly below its own highest role. */
function requireRoleBelowBot(
	guild: ManageableGuild,
	role: ManageableRole,
	operation: string,
): void {
	const me = requireBotMember(guild);
	if (role.managed) {
		throw new GuildManagementError(
			"ROLE_MANAGED",
			`Role "${role.name}" is integration-managed and cannot be modified.`,
		);
	}
	if (role.id === guild.roles.everyone.id) {
		throw new GuildManagementError(
			"ROLE_EVERYONE",
			`The @everyone role cannot be targeted by ${operation}; use edit_permissions channel overwrites instead.`,
		);
	}
	if (role.position >= me.roles.highest.position) {
		throw new GuildManagementError(
			"ROLE_HIERARCHY",
			`Role "${role.name}" (position ${role.position}) is not below the bot's highest role (position ${me.roles.highest.position}); Discord role hierarchy forbids this ${operation}.`,
		);
	}
}

/** Requested permissions must be a subset of what the bot itself holds. */
function requirePermissionSubset(
	guild: ManageableGuild,
	permissions: string[],
	label: string,
): void {
	const me = requireBotMember(guild);
	if (me.permissions.has("Administrator")) return;
	const missing = permissions.filter((name) => !me.permissions.has(name));
	if (missing.length > 0) {
		throw new GuildManagementError(
			"PERMISSION_ESCALATION",
			`${label} grants permissions the bot itself does not hold (${missing.join(", ")}); refusing the escalation.`,
		);
	}
}

async function fetchRole(
	guild: ManageableGuild,
	roleId: string,
): Promise<ManageableRole> {
	const fetched = await fetchOptionalRole(guild, roleId);
	if (!fetched) {
		throw new GuildManagementError(
			"ROLE_NOT_FOUND",
			`Role ${roleId} was not found in guild "${guild.name}".`,
		);
	}
	return fetched;
}

function discordErrorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" || typeof code === "number"
		? String(code)
		: undefined;
}

async function fetchOptionalRole(
	guild: ManageableGuild,
	roleId: string,
): Promise<ManageableRole | null> {
	const cached = guild.roles.cache.get(roleId);
	if (cached) return cached;
	try {
		return await guild.roles.fetch(roleId);
	} catch (error) {
		// error-policy:J4 Discord's exact Unknown Role response is a designed
		// missing state; every other provider failure remains a typed error.
		if (discordErrorCode(error) === "10011") return null;
		throw new GuildManagementError(
			"ROLE_FETCH_FAILED",
			`Discord failed to fetch role ${roleId} from guild "${guild.name}".`,
			error,
		);
	}
}

async function fetchChannel(
	guild: ManageableGuild,
	channelId: string,
): Promise<ManageableChannel> {
	const fetched = await fetchOptionalChannel(guild, channelId);
	if (!fetched) {
		throw new GuildManagementError(
			"CHANNEL_NOT_FOUND",
			`Channel ${channelId} was not found in guild "${guild.name}".`,
		);
	}
	if (fetched.guildId && fetched.guildId !== guild.id) {
		throw new GuildManagementError(
			"CHANNEL_WRONG_GUILD",
			`Channel ${channelId} does not belong to guild "${guild.name}".`,
		);
	}
	return fetched;
}

async function fetchOptionalChannel(
	guild: ManageableGuild,
	channelId: string,
): Promise<ManageableChannel | null> {
	const cached = guild.channels.cache.get(channelId);
	if (cached) return cached;
	try {
		return await guild.channels.fetch(channelId);
	} catch (error) {
		// error-policy:J4 Discord's exact Unknown Channel response is a designed
		// missing state; every other provider failure remains a typed error.
		if (discordErrorCode(error) === "10003") return null;
		throw new GuildManagementError(
			"CHANNEL_FETCH_FAILED",
			`Discord failed to fetch channel ${channelId} from guild "${guild.name}".`,
			error,
		);
	}
}

async function fetchOptionalMember(
	guild: ManageableGuild,
	userId: string,
): Promise<ManageableMember | null> {
	try {
		return await guild.members.fetch(userId);
	} catch (error) {
		// error-policy:J4 Discord's exact Unknown Member response is a designed
		// missing state; every other provider failure remains a typed error.
		if (discordErrorCode(error) === "10007") return null;
		throw new GuildManagementError(
			"MEMBER_FETCH_FAILED",
			`Discord failed to fetch member ${userId} from guild "${guild.name}".`,
			error,
		);
	}
}

async function fetchMember(
	guild: ManageableGuild,
	userId: string,
): Promise<ManageableMember> {
	const member = await fetchOptionalMember(guild, userId);
	if (!member) {
		throw new GuildManagementError(
			"MEMBER_NOT_FOUND",
			`Member ${userId} was not found in guild "${guild.name}".`,
		);
	}
	return member;
}

function requireName(request: GuildManagementRequest): string {
	const name = request.name?.trim();
	if (!name) {
		throw new GuildManagementError(
			"NAME_REQUIRED",
			`${request.operation} requires a non-empty name.`,
		);
	}
	if (name.length > GUILD_TEMPLATE_LIMITS.maxNameLength) {
		throw new GuildManagementError(
			"NAME_TOO_LONG",
			`Names are limited to ${GUILD_TEMPLATE_LIMITS.maxNameLength} characters.`,
		);
	}
	return name;
}

function normalizeTopic(topic: string | undefined): string | undefined {
	if (topic === undefined) return undefined;
	const normalized = topic.trim();
	if (normalized.length > GUILD_TEMPLATE_LIMITS.maxTopicLength) {
		throw new GuildManagementError(
			"TOPIC_TOO_LONG",
			`Channel topics are limited to ${GUILD_TEMPLATE_LIMITS.maxTopicLength} characters.`,
		);
	}
	return normalized;
}

function parseColor(raw: string | undefined): number | undefined {
	if (!raw) return undefined;
	const match = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
	if (!match) {
		throw new GuildManagementError(
			"COLOR_INVALID",
			`Color "${raw}" is not a #RRGGBB hex color.`,
		);
	}
	return Number.parseInt(match[1], 16);
}

const CHANNEL_TYPE_MAP: Record<GuildTemplateChannelType, number> = {
	text: ChannelType.GuildText,
	voice: ChannelType.GuildVoice,
	announcement: ChannelType.GuildAnnouncement,
	forum: ChannelType.GuildForum,
	stage: ChannelType.GuildStageVoice,
};

function resolveChannelType(raw: string | undefined): number {
	if (!raw) return ChannelType.GuildText;
	const normalized = raw.trim().toLowerCase() as GuildTemplateChannelType;
	const mapped = CHANNEL_TYPE_MAP[normalized];
	if (mapped === undefined) {
		throw new GuildManagementError(
			"CHANNEL_TYPE_INVALID",
			`Channel type "${raw}" is not one of: ${Object.keys(CHANNEL_TYPE_MAP).join(", ")}.`,
		);
	}
	return mapped;
}

function auditReason(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): string {
	const prefix = context.reasonPrefix ?? "eliza guild management";
	const extra = request.reason?.trim();
	return extra ? `${prefix}: ${extra}`.slice(0, 512) : prefix;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function executeGuildManagement(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const operation = normalizeGuildManagementOperation(request.operation);
	if (!operation) {
		throw new GuildManagementError(
			"OPERATION_UNKNOWN",
			`Unknown guild management operation "${String(request.operation)}". Supported: ${GUILD_MANAGEMENT_OPERATIONS.join(", ")}.`,
		);
	}
	requireGates(context.gates, operation);
	const normalizedRequest = { ...request, operation };

	switch (operation) {
		case "list_templates":
			return listTemplates(context, normalizedRequest);
		case "create_category":
			return createChannelOp(context, normalizedRequest, true);
		case "create_channel":
			return createChannelOp(context, normalizedRequest, false);
		case "edit_channel":
			return editChannelOp(context, normalizedRequest);
		case "delete_channel":
			return deleteChannelOp(context, normalizedRequest);
		case "create_role":
			return createRoleOp(context, normalizedRequest);
		case "edit_role":
			return editRoleOp(context, normalizedRequest);
		case "delete_role":
			return deleteRoleOp(context, normalizedRequest);
		case "edit_permissions":
			return editPermissionsOp(context, normalizedRequest);
		case "assign_role":
		case "remove_role":
			return memberRoleOp(context, normalizedRequest, operation);
		case "create_invite":
			return createInviteOp(context, normalizedRequest);
		case "kick":
		case "ban":
		case "unban":
		case "timeout":
			return moderationOp(context, normalizedRequest, operation);
		case "apply_template":
			return applyTemplateOp(context, normalizedRequest);
		default: {
			const unreachable: never = operation;
			throw new GuildManagementError(
				"OPERATION_UNKNOWN",
				`Unhandled operation ${String(unreachable)}.`,
			);
		}
	}
}

function receipt(
	context: GuildManagementContext,
	request: GuildManagementRequest,
	entries: ReceiptEntry[],
	summary: string,
	extra?: Partial<GuildManagementReceipt>,
): GuildManagementReceipt {
	return {
		operation: request.operation,
		guildId: context.guild.id,
		guildName: context.guild.name,
		dryRun: request.dryRun === true,
		entries,
		summary,
		...extra,
	};
}

// ---------------------------------------------------------------------------
// Templates listing
// ---------------------------------------------------------------------------

function templateRegistry(
	context: GuildManagementContext,
): Record<string, GuildTemplate> {
	return {
		...BUILT_IN_GUILD_TEMPLATES,
		...(context.templateRegistry ?? {}),
	};
}

function listTemplates(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): GuildManagementReceipt {
	const registry = templateRegistry(context);
	const templates = Object.values(registry)
		.map((template) => ({
			id: template.id,
			description: template.description,
		}))
		.sort((a, b) => a.id.localeCompare(b.id));
	return receipt(
		context,
		request,
		[],
		`${templates.length} guild templates available: ${templates.map((t) => t.id).join(", ")}.`,
		{ templates },
	);
}

// ---------------------------------------------------------------------------
// Channel verbs
// ---------------------------------------------------------------------------

async function createChannelOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
	isCategory: boolean,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageChannels", request.operation);
	const name = requireName(request);
	const type = isCategory
		? ChannelType.GuildCategory
		: resolveChannelType(request.channelType);
	const topic = normalizeTopic(request.topic);
	let parentId: string | undefined;
	if (!isCategory && request.parentId) {
		const parent = await fetchChannel(guild, request.parentId);
		if (parent.type !== ChannelType.GuildCategory) {
			throw new GuildManagementError(
				"PARENT_NOT_CATEGORY",
				`Parent channel ${parent.id} ("${parent.name}") is not a category.`,
			);
		}
		parentId = parent.id;
	}
	const kind = isCategory ? "category" : "channel";
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[{ kind, action: "would_create", name }],
			`Dry run: would create ${kind} "${name}" in "${guild.name}".`,
		);
	}
	const created = await guild.channels.create({
		name,
		type,
		...(parentId ? { parent: parentId } : {}),
		...(topic ? { topic } : {}),
		reason: auditReason(context, request),
	});
	return receipt(
		context,
		request,
		[{ kind, action: "created", name: created.name, id: created.id }],
		`Created ${kind} "${created.name}" (${created.id}) in "${guild.name}".`,
	);
}

async function editChannelOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageChannels", request.operation);
	if (!request.channelId) {
		throw new GuildManagementError(
			"CHANNEL_ID_REQUIRED",
			"edit_channel requires channelId.",
		);
	}
	const channel = await fetchChannel(guild, request.channelId);
	const changes: Record<string, unknown> = {};
	if (request.name?.trim()) changes.name = requireName(request);
	if (request.topic !== undefined)
		changes.topic = normalizeTopic(request.topic);
	if (request.parentId) {
		const parent = await fetchChannel(guild, request.parentId);
		if (parent.type !== ChannelType.GuildCategory) {
			throw new GuildManagementError(
				"PARENT_NOT_CATEGORY",
				`Parent channel ${parent.id} ("${parent.name}") is not a category.`,
			);
		}
		changes.parent = parent.id;
	}
	if (Object.keys(changes).length === 0) {
		throw new GuildManagementError(
			"NO_CHANGES",
			"edit_channel requires at least one of name, topic, or parentId.",
		);
	}
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "channel",
					action: "would_update",
					name: channel.name,
					id: channel.id,
				},
			],
			`Dry run: would update channel "${channel.name}" (${Object.keys(changes).join(", ")}).`,
		);
	}
	const updated = await channel.edit({
		...changes,
		reason: auditReason(context, request),
	});
	return receipt(
		context,
		request,
		[
			{
				kind: "channel",
				action: "updated",
				name: updated.name ?? channel.name,
				id: channel.id,
			},
		],
		`Updated channel "${updated.name ?? channel.name}" (${Object.keys(changes).join(", ")}).`,
	);
}

async function deleteChannelOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageChannels", request.operation);
	if (!request.channelId) {
		throw new GuildManagementError(
			"CHANNEL_ID_REQUIRED",
			"delete_channel requires channelId.",
		);
	}
	const channel = await fetchChannel(guild, request.channelId);
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "channel",
					action: "skipped",
					name: channel.name,
					id: channel.id,
					reason: "dry run",
				},
			],
			`Dry run: would delete channel "${channel.name}" (${channel.id}).`,
		);
	}
	await channel.delete(auditReason(context, request));
	return receipt(
		context,
		request,
		[
			{
				kind: "channel",
				action: "deleted",
				name: channel.name,
				id: channel.id,
			},
		],
		`Deleted channel "${channel.name}" (${channel.id}) from "${guild.name}".`,
	);
}

// ---------------------------------------------------------------------------
// Role verbs
// ---------------------------------------------------------------------------

async function createRoleOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageRoles", request.operation);
	const name = requireName(request);
	const permissions = normalizePermissionList(
		request.permissions,
		`create_role "${name}"`,
	);
	requirePermissionSubset(guild, permissions, `create_role "${name}"`);
	const color = parseColor(request.color);
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[{ kind: "role", action: "would_create", name }],
			`Dry run: would create role "${name}" in "${guild.name}".`,
		);
	}
	const created = await guild.roles.create({
		name,
		...(color !== undefined ? { color } : {}),
		...(request.hoist !== undefined ? { hoist: request.hoist } : {}),
		...(request.mentionable !== undefined
			? { mentionable: request.mentionable }
			: {}),
		permissions,
		reason: auditReason(context, request),
	});
	return receipt(
		context,
		request,
		[{ kind: "role", action: "created", name: created.name, id: created.id }],
		`Created role "${created.name}" (${created.id}) in "${guild.name}".`,
	);
}

async function editRoleOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageRoles", request.operation);
	if (!request.roleId) {
		throw new GuildManagementError(
			"ROLE_ID_REQUIRED",
			"edit_role requires roleId.",
		);
	}
	const role = await fetchRole(guild, request.roleId);
	requireRoleBelowBot(guild, role, "edit_role");
	const changes: Record<string, unknown> = {};
	if (request.name?.trim()) changes.name = requireName(request);
	const color = parseColor(request.color);
	if (color !== undefined) changes.color = color;
	if (request.hoist !== undefined) changes.hoist = request.hoist;
	if (request.mentionable !== undefined)
		changes.mentionable = request.mentionable;
	if (request.permissions !== undefined) {
		const permissions = normalizePermissionList(
			request.permissions,
			`edit_role "${role.name}"`,
		);
		requirePermissionSubset(guild, permissions, `edit_role "${role.name}"`);
		changes.permissions = permissions;
	}
	if (Object.keys(changes).length === 0) {
		throw new GuildManagementError(
			"NO_CHANGES",
			"edit_role requires at least one of name, color, hoist, mentionable, or permissions.",
		);
	}
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "role",
					action: "would_update",
					name: role.name,
					id: role.id,
				},
			],
			`Dry run: would update role "${role.name}" (${Object.keys(changes).join(", ")}).`,
		);
	}
	const updated = await role.edit({
		...changes,
		reason: auditReason(context, request),
	});
	return receipt(
		context,
		request,
		[
			{
				kind: "role",
				action: "updated",
				name: updated.name ?? role.name,
				id: role.id,
			},
		],
		`Updated role "${updated.name ?? role.name}" (${Object.keys(changes).join(", ")}).`,
	);
}

async function deleteRoleOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageRoles", request.operation);
	if (!request.roleId) {
		throw new GuildManagementError(
			"ROLE_ID_REQUIRED",
			"delete_role requires roleId.",
		);
	}
	const role = await fetchRole(guild, request.roleId);
	requireRoleBelowBot(guild, role, "delete_role");
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "role",
					action: "skipped",
					name: role.name,
					id: role.id,
					reason: "dry run",
				},
			],
			`Dry run: would delete role "${role.name}" (${role.id}).`,
		);
	}
	await role.delete(auditReason(context, request));
	return receipt(
		context,
		request,
		[{ kind: "role", action: "deleted", name: role.name, id: role.id }],
		`Deleted role "${role.name}" (${role.id}) from "${guild.name}".`,
	);
}

// ---------------------------------------------------------------------------
// Permission overwrites
// ---------------------------------------------------------------------------

async function editPermissionsOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageRoles", request.operation);
	if (!request.channelId) {
		throw new GuildManagementError(
			"CHANNEL_ID_REQUIRED",
			"edit_permissions requires channelId.",
		);
	}
	if (!request.overwriteId?.trim()) {
		throw new GuildManagementError(
			"OVERWRITE_TARGET_REQUIRED",
			'edit_permissions requires overwriteId (a role id, user id, or "@everyone").',
		);
	}
	const allow = normalizePermissionList(
		request.allow,
		"edit_permissions allow",
	);
	const deny = normalizePermissionList(request.deny, "edit_permissions deny");
	if (allow.length === 0 && deny.length === 0) {
		throw new GuildManagementError(
			"NO_CHANGES",
			"edit_permissions requires at least one allow or deny permission.",
		);
	}
	const overlap = allow.filter((name) => deny.includes(name));
	if (overlap.length > 0) {
		throw new GuildManagementError(
			"PERMISSION_CONFLICT",
			`edit_permissions lists ${overlap.join(", ")} in both allow and deny.`,
		);
	}
	requirePermissionSubset(guild, allow, "edit_permissions allow");
	const channel = await fetchChannel(guild, request.channelId);
	if (!channel.permissionOverwrites) {
		throw new GuildManagementError(
			"OVERWRITES_UNSUPPORTED",
			`Channel "${channel.name}" does not support permission overwrites.`,
		);
	}
	const subject =
		request.overwriteId.trim() === "@everyone"
			? guild.roles.everyone.id
			: request.overwriteId.trim();
	if (!/^\d{5,22}$/.test(subject)) {
		throw new GuildManagementError(
			"OVERWRITE_TARGET_INVALID",
			`edit_permissions overwriteId "${request.overwriteId}" is not a Discord id or "@everyone".`,
		);
	}
	// If the subject is a role, hierarchy still applies.
	const subjectRole = guild.roles.cache.get(subject);
	if (subjectRole && subjectRole.id !== guild.roles.everyone.id) {
		requireRoleBelowBot(guild, subjectRole, "edit_permissions");
	}
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "overwrite",
					action: "would_update",
					name: channel.name,
					id: subject,
				},
			],
			`Dry run: would edit overwrites for ${subject} on "${channel.name}" (allow: ${allow.join(", ") || "none"}; deny: ${deny.join(", ") || "none"}).`,
		);
	}
	const options: Record<string, boolean | null> = {};
	for (const name of allow) options[name] = true;
	for (const name of deny) options[name] = false;
	await channel.permissionOverwrites.edit(subject, options, {
		reason: auditReason(context, request),
	});
	return receipt(
		context,
		request,
		[
			{
				kind: "overwrite",
				action: "updated",
				name: channel.name,
				id: subject,
			},
		],
		`Edited permission overwrites for ${subject} on "${channel.name}" (allow: ${allow.join(", ") || "none"}; deny: ${deny.join(", ") || "none"}).`,
	);
}

// ---------------------------------------------------------------------------
// Member role assignment
// ---------------------------------------------------------------------------

async function memberRoleOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
	operation: "assign_role" | "remove_role",
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageRoles", operation);
	if (!request.userId) {
		throw new GuildManagementError(
			"USER_ID_REQUIRED",
			`${operation} requires userId.`,
		);
	}
	if (!request.roleId) {
		throw new GuildManagementError(
			"ROLE_ID_REQUIRED",
			`${operation} requires roleId.`,
		);
	}
	const role = await fetchRole(guild, request.roleId);
	requireRoleBelowBot(guild, role, operation);
	const member = await fetchMember(guild, request.userId);
	const hasRole = member.roles.cache.has(role.id);
	if (operation === "assign_role" && hasRole) {
		return receipt(
			context,
			request,
			[
				{
					kind: "member_role",
					action: "unchanged",
					name: role.name,
					id: role.id,
				},
			],
			`Member ${member.id} already has role "${role.name}".`,
		);
	}
	if (operation === "remove_role" && !hasRole) {
		return receipt(
			context,
			request,
			[
				{
					kind: "member_role",
					action: "unchanged",
					name: role.name,
					id: role.id,
				},
			],
			`Member ${member.id} does not have role "${role.name}".`,
		);
	}
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "member_role",
					action: "would_update",
					name: role.name,
					id: role.id,
				},
			],
			`Dry run: would ${operation === "assign_role" ? "assign" : "remove"} role "${role.name}" ${operation === "assign_role" ? "to" : "from"} member ${member.id}.`,
		);
	}
	if (operation === "assign_role") {
		await member.roles.add(role.id, auditReason(context, request));
	} else {
		await member.roles.remove(role.id, auditReason(context, request));
	}
	return receipt(
		context,
		request,
		[
			{
				kind: "member_role",
				action: "updated",
				name: role.name,
				id: role.id,
			},
		],
		`${operation === "assign_role" ? "Assigned" : "Removed"} role "${role.name}" ${operation === "assign_role" ? "to" : "from"} member ${member.id}.`,
	);
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const MAX_INVITE_AGE_SECONDS = 7 * 24 * 60 * 60;

async function createInviteOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "CreateInstantInvite", request.operation);
	if (!request.channelId) {
		throw new GuildManagementError(
			"CHANNEL_ID_REQUIRED",
			"create_invite requires channelId.",
		);
	}
	const channel = await fetchChannel(guild, request.channelId);
	if (typeof channel.createInvite !== "function") {
		throw new GuildManagementError(
			"INVITES_UNSUPPORTED",
			`Channel "${channel.name}" does not support invites.`,
		);
	}
	const maxAge = Math.min(
		Math.max(Math.floor(request.maxAgeSeconds ?? 86400), 0),
		MAX_INVITE_AGE_SECONDS,
	);
	const maxUses = Math.min(Math.max(Math.floor(request.maxUses ?? 0), 0), 100);
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "invite",
					action: "skipped",
					name: channel.name,
					id: channel.id,
					reason: "dry run",
				},
			],
			`Dry run: would create an invite for "${channel.name}" (maxAge ${maxAge}s, maxUses ${maxUses || "unlimited"}).`,
		);
	}
	const invite = await channel.createInvite({
		maxAge,
		maxUses,
		unique: request.unique !== false,
		reason: auditReason(context, request),
	});
	const url = invite.url ?? `https://discord.gg/${invite.code}`;
	return receipt(
		context,
		request,
		[
			{
				kind: "invite",
				action: "created",
				name: channel.name,
				id: invite.code,
			},
		],
		`Created invite ${url} for "${channel.name}" (expires ${maxAge ? `${maxAge}s` : "never"}, uses ${maxUses || "unlimited"}).`,
		{ invite: { code: invite.code, url } },
	);
}

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;

async function moderationOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
	operation: "kick" | "ban" | "unban" | "timeout",
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	const permissionByOp: Record<typeof operation, string> = {
		kick: "KickMembers",
		ban: "BanMembers",
		unban: "BanMembers",
		timeout: "ModerateMembers",
	};
	requireBotPermission(guild, permissionByOp[operation], operation);
	if (!request.userId) {
		throw new GuildManagementError(
			"USER_ID_REQUIRED",
			`${operation} requires userId.`,
		);
	}
	if (!/^\d{5,22}$/.test(request.userId.trim())) {
		throw new GuildManagementError(
			"USER_ID_INVALID",
			`${operation} userId "${request.userId}" is not a Discord user id.`,
		);
	}
	const userId = request.userId.trim();
	if (guild.ownerId && userId === guild.ownerId) {
		throw new GuildManagementError(
			"MODERATION_OWNER",
			`Refusing ${operation} against the guild owner.`,
		);
	}
	if (request.dryRun) {
		return receipt(
			context,
			request,
			[
				{
					kind: "member",
					action: "skipped",
					id: userId,
					reason: "dry run",
				},
			],
			`Dry run: would ${operation} member ${userId}.`,
		);
	}
	const reason = auditReason(context, request);
	if (operation === "unban") {
		await guild.bans.remove(userId, reason);
		return receipt(
			context,
			request,
			[{ kind: "member", action: "updated", id: userId }],
			`Unbanned ${userId} from "${guild.name}".`,
		);
	}
	if (operation === "ban") {
		// Hierarchy check when the member is present; bans of absent users pass
		// straight to the API.
		const member = await fetchOptionalMember(guild, userId);
		if (member && member.bannable === false) {
			throw new GuildManagementError(
				"MODERATION_HIERARCHY",
				`Member ${userId} is not bannable by the bot (role hierarchy).`,
			);
		}
		const deleteMessageSeconds = Math.min(
			Math.max(Math.floor(request.deleteMessageSeconds ?? 0), 0),
			7 * 24 * 60 * 60,
		);
		await guild.bans.create(userId, {
			reason,
			...(deleteMessageSeconds ? { deleteMessageSeconds } : {}),
		});
		return receipt(
			context,
			request,
			[{ kind: "member", action: "updated", id: userId }],
			`Banned ${userId} from "${guild.name}".`,
		);
	}
	const member = await fetchMember(guild, userId);
	if (operation === "kick") {
		if (member.kickable === false) {
			throw new GuildManagementError(
				"MODERATION_HIERARCHY",
				`Member ${userId} is not kickable by the bot (role hierarchy).`,
			);
		}
		await member.kick(reason);
		return receipt(
			context,
			request,
			[{ kind: "member", action: "updated", id: userId }],
			`Kicked ${userId} from "${guild.name}".`,
		);
	}
	if (member.moderatable === false) {
		throw new GuildManagementError(
			"MODERATION_HIERARCHY",
			`Member ${userId} is not moderatable by the bot (role hierarchy).`,
		);
	}
	const minutes = Math.min(
		Math.max(Math.floor(request.durationMinutes ?? 10), 1),
		MAX_TIMEOUT_MINUTES,
	);
	await member.timeout(minutes * 60 * 1000, reason);
	return receipt(
		context,
		request,
		[{ kind: "member", action: "updated", id: userId }],
		`Timed out ${userId} for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
	);
}

// ---------------------------------------------------------------------------
// Template reconcile
// ---------------------------------------------------------------------------

interface ReconcileMaps {
	state: Record<string, string>;
	roleIdByKey: Map<string, string>;
	channelIdByKey: Map<string, string>;
}

function renderVars(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Record<string, string> {
	return {
		agent: context.agentName ?? "Agent",
		guild: context.guild.name,
		...(request.variables ?? {}),
	};
}

function renderTemplateName(
	value: string,
	variables: Record<string, string>,
	label: string,
): string {
	const rendered = renderTemplateString(value, variables).trim();
	if (!rendered) {
		throw new GuildManagementError(
			"TEMPLATE_RENDER_INVALID",
			`${label} rendered to an empty name.`,
		);
	}
	if (rendered.length > GUILD_TEMPLATE_LIMITS.maxNameLength) {
		throw new GuildManagementError(
			"TEMPLATE_RENDER_INVALID",
			`${label} rendered beyond the ${GUILD_TEMPLATE_LIMITS.maxNameLength}-character name limit.`,
		);
	}
	return rendered;
}

function renderTemplateTopic(
	value: string,
	variables: Record<string, string>,
	label: string,
): string {
	const rendered = renderTemplateString(value, variables).trim();
	if (rendered.length > GUILD_TEMPLATE_LIMITS.maxTopicLength) {
		throw new GuildManagementError(
			"TEMPLATE_RENDER_INVALID",
			`${label} rendered beyond the ${GUILD_TEMPLATE_LIMITS.maxTopicLength}-character topic limit.`,
		);
	}
	return rendered;
}

async function applyTemplateOp(
	context: GuildManagementContext,
	request: GuildManagementRequest,
): Promise<GuildManagementReceipt> {
	const { guild } = context;
	requireBotPermission(guild, "ManageChannels", "apply_template");
	requireBotPermission(guild, "ManageRoles", "apply_template");

	const registry = templateRegistry(context);
	let template: GuildTemplate | undefined;
	if (request.templateSpec) {
		template = request.templateSpec;
	} else if (request.template) {
		template = registry[request.template.trim()];
		if (!template) {
			throw new GuildManagementError(
				"TEMPLATE_NOT_FOUND",
				`Template "${request.template}" is not registered. Available: ${Object.keys(
					registry,
				)
					.sort()
					.join(", ")}.`,
			);
		}
	} else {
		throw new GuildManagementError(
			"TEMPLATE_REQUIRED",
			"apply_template requires template (registered id) or templateSpec (inline spec).",
		);
	}
	const validationErrors = validateGuildTemplate(template);
	if (validationErrors.length > 0) {
		throw new GuildManagementError(
			"TEMPLATE_INVALID",
			`Template "${template.id}" failed validation: ${validationErrors.join("; ")}.`,
		);
	}
	const variables = renderVars(context, request);
	const dryRun = request.dryRun === true;
	const entries: ReceiptEntry[] = [];
	const maps: ReconcileMaps = {
		state:
			(await context.stateStore.get(guild.id, template.id)) ??
			({} as Record<string, string>),
		roleIdByKey: new Map(),
		channelIdByKey: new Map(),
	};
	const reason = auditReason(context, request);

	await reconcileRoles(context, template, variables, maps, entries, {
		dryRun,
		reason,
	});
	await reconcileCategories(context, template, variables, maps, entries, {
		dryRun,
		reason,
	});
	await reconcileChannels(context, template, variables, maps, entries, {
		dryRun,
		reason,
	});
	await reconcileOverwrites(context, template, maps, entries, {
		dryRun,
		reason,
	});

	if (!dryRun) {
		await context.stateStore.set(guild.id, template.id, maps.state);
	}
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		counts[entry.action] = (counts[entry.action] ?? 0) + 1;
	}
	const countText = Object.entries(counts)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([action, count]) => `${action}: ${count}`)
		.join(", ");
	return receipt(
		context,
		request,
		entries,
		`${dryRun ? "Dry run of" : "Applied"} template "${template.id}" on "${guild.name}" (${countText || "no objects"}). Unmanaged channels and roles were left untouched.`,
	);
}

interface ReconcileOptions {
	dryRun: boolean;
	reason: string;
}

async function resolveTrackedRole(
	guild: ManageableGuild,
	stateId: string | undefined,
	renderedName: string,
): Promise<ManageableRole | undefined> {
	if (stateId) {
		const byId = await fetchOptionalRole(guild, stateId);
		if (byId) return byId;
	}
	for (const role of guild.roles.cache.values()) {
		if (
			!role.managed &&
			role.id !== guild.roles.everyone.id &&
			role.name === renderedName
		) {
			return role;
		}
	}
	return undefined;
}

async function reconcileRoles(
	context: GuildManagementContext,
	template: GuildTemplate,
	variables: Record<string, string>,
	maps: ReconcileMaps,
	entries: ReceiptEntry[],
	options: ReconcileOptions,
): Promise<void> {
	const { guild } = context;
	for (const spec of template.roles ?? []) {
		const stateKey = `role:${spec.key}`;
		const renderedName = renderTemplateName(
			spec.name,
			variables,
			`template role "${spec.key}"`,
		);
		const permissions = normalizePermissionList(
			spec.permissions,
			`template role "${spec.key}"`,
		);
		requirePermissionSubset(guild, permissions, `template role "${spec.key}"`);
		const color = parseColor(spec.color);
		const existing = await resolveTrackedRole(
			guild,
			maps.state[stateKey],
			renderedName,
		);
		if (!existing) {
			if (options.dryRun) {
				entries.push({
					kind: "role",
					key: spec.key,
					name: renderedName,
					action: "would_create",
				});
				continue;
			}
			const created = await guild.roles.create({
				name: renderedName,
				...(color !== undefined ? { color } : {}),
				...(spec.hoist !== undefined ? { hoist: spec.hoist } : {}),
				...(spec.mentionable !== undefined
					? { mentionable: spec.mentionable }
					: {}),
				permissions,
				reason: options.reason,
			});
			maps.state[stateKey] = created.id;
			maps.roleIdByKey.set(spec.key, created.id);
			entries.push({
				kind: "role",
				key: spec.key,
				name: renderedName,
				id: created.id,
				action: "created",
			});
			continue;
		}
		maps.roleIdByKey.set(spec.key, existing.id);
		maps.state[stateKey] = existing.id;
		const drift: Record<string, unknown> = {};
		if (existing.name !== renderedName) drift.name = renderedName;
		if (color !== undefined && existing.color !== color) drift.color = color;
		if (spec.hoist !== undefined && existing.hoist !== spec.hoist)
			drift.hoist = spec.hoist;
		if (
			spec.mentionable !== undefined &&
			existing.mentionable !== spec.mentionable
		)
			drift.mentionable = spec.mentionable;
		if (spec.permissions !== undefined) {
			const current = existing.permissions.toArray
				? [...existing.permissions.toArray()].sort()
				: undefined;
			if (current && current.join("|") !== permissions.join("|")) {
				drift.permissions = permissions;
			}
		}
		if (Object.keys(drift).length === 0) {
			entries.push({
				kind: "role",
				key: spec.key,
				name: existing.name,
				id: existing.id,
				action: "unchanged",
			});
			continue;
		}
		if (options.dryRun) {
			entries.push({
				kind: "role",
				key: spec.key,
				name: existing.name,
				id: existing.id,
				action: "would_update",
			});
			continue;
		}
		requireRoleBelowBot(guild, existing, "apply_template role update");
		await existing.edit({ ...drift, reason: options.reason });
		entries.push({
			kind: "role",
			key: spec.key,
			name: renderedName,
			id: existing.id,
			action: "updated",
		});
	}
}

async function resolveTrackedChannel(
	guild: ManageableGuild,
	stateId: string | undefined,
	renderedName: string,
	type: number,
	parentId?: string,
): Promise<ManageableChannel | undefined> {
	if (stateId) {
		const byId = await fetchOptionalChannel(guild, stateId);
		if (byId) return byId;
	}
	for (const channel of guild.channels.cache.values()) {
		if (channel.type !== type) continue;
		if (channel.name !== renderedName) continue;
		if (parentId !== undefined && (channel.parentId ?? undefined) !== parentId)
			continue;
		return channel;
	}
	// Second pass without the parent constraint so a manually-moved managed
	// channel is adopted (and re-parented) instead of duplicated.
	for (const channel of guild.channels.cache.values()) {
		if (channel.type === type && channel.name === renderedName) return channel;
	}
	return undefined;
}

async function reconcileCategories(
	context: GuildManagementContext,
	template: GuildTemplate,
	variables: Record<string, string>,
	maps: ReconcileMaps,
	entries: ReceiptEntry[],
	options: ReconcileOptions,
): Promise<void> {
	const { guild } = context;
	for (const spec of template.categories ?? []) {
		const stateKey = `category:${spec.key}`;
		const renderedName = renderTemplateName(
			spec.name,
			variables,
			`template category "${spec.key}"`,
		);
		const existing = await resolveTrackedChannel(
			guild,
			maps.state[stateKey],
			renderedName,
			ChannelType.GuildCategory,
		);
		if (!existing) {
			if (options.dryRun) {
				entries.push({
					kind: "category",
					key: spec.key,
					name: renderedName,
					action: "would_create",
				});
				continue;
			}
			const created = await guild.channels.create({
				name: renderedName,
				type: ChannelType.GuildCategory,
				reason: options.reason,
			});
			maps.state[stateKey] = created.id;
			maps.channelIdByKey.set(spec.key, created.id);
			entries.push({
				kind: "category",
				key: spec.key,
				name: renderedName,
				id: created.id,
				action: "created",
			});
			continue;
		}
		maps.channelIdByKey.set(spec.key, existing.id);
		maps.state[stateKey] = existing.id;
		if (existing.name !== renderedName) {
			if (options.dryRun) {
				entries.push({
					kind: "category",
					key: spec.key,
					name: existing.name,
					id: existing.id,
					action: "would_update",
				});
				continue;
			}
			await existing.edit({ name: renderedName, reason: options.reason });
			entries.push({
				kind: "category",
				key: spec.key,
				name: renderedName,
				id: existing.id,
				action: "updated",
			});
			continue;
		}
		entries.push({
			kind: "category",
			key: spec.key,
			name: existing.name,
			id: existing.id,
			action: "unchanged",
		});
	}
}

async function reconcileChannels(
	context: GuildManagementContext,
	template: GuildTemplate,
	variables: Record<string, string>,
	maps: ReconcileMaps,
	entries: ReceiptEntry[],
	options: ReconcileOptions,
): Promise<void> {
	const { guild } = context;
	for (const spec of template.channels ?? []) {
		const stateKey = `channel:${spec.key}`;
		const renderedName = renderTemplateName(
			spec.name,
			variables,
			`template channel "${spec.key}"`,
		);
		const renderedTopic =
			spec.topic !== undefined
				? renderTemplateTopic(
						spec.topic,
						variables,
						`template channel "${spec.key}"`,
					)
				: undefined;
		const type = CHANNEL_TYPE_MAP[spec.type ?? "text"];
		const parentId = spec.parent
			? maps.channelIdByKey.get(spec.parent)
			: undefined;
		if (spec.parent && !parentId && !options.dryRun) {
			entries.push({
				kind: "channel",
				key: spec.key,
				name: renderedName,
				action: "skipped",
				reason: `parent category "${spec.parent}" was not resolved`,
			});
			continue;
		}
		const existing = await resolveTrackedChannel(
			guild,
			maps.state[stateKey],
			renderedName,
			type,
			parentId,
		);
		if (!existing) {
			if (options.dryRun) {
				entries.push({
					kind: "channel",
					key: spec.key,
					name: renderedName,
					action: "would_create",
				});
				continue;
			}
			const created = await guild.channels.create({
				name: renderedName,
				type,
				...(parentId ? { parent: parentId } : {}),
				...(renderedTopic !== undefined && type === ChannelType.GuildText
					? { topic: renderedTopic }
					: {}),
				reason: options.reason,
			});
			maps.state[stateKey] = created.id;
			maps.channelIdByKey.set(spec.key, created.id);
			entries.push({
				kind: "channel",
				key: spec.key,
				name: renderedName,
				id: created.id,
				action: "created",
			});
			continue;
		}
		maps.channelIdByKey.set(spec.key, existing.id);
		maps.state[stateKey] = existing.id;
		const drift: Record<string, unknown> = {};
		if (existing.name !== renderedName) drift.name = renderedName;
		if (
			renderedTopic !== undefined &&
			type === ChannelType.GuildText &&
			(existing.topic ?? "") !== renderedTopic
		) {
			drift.topic = renderedTopic;
		}
		if (
			parentId !== undefined &&
			(existing.parentId ?? undefined) !== parentId
		) {
			drift.parent = parentId;
		}
		if (Object.keys(drift).length === 0) {
			entries.push({
				kind: "channel",
				key: spec.key,
				name: existing.name,
				id: existing.id,
				action: "unchanged",
			});
			continue;
		}
		if (options.dryRun) {
			entries.push({
				kind: "channel",
				key: spec.key,
				name: existing.name,
				id: existing.id,
				action: "would_update",
			});
			continue;
		}
		await existing.edit({ ...drift, reason: options.reason });
		entries.push({
			kind: "channel",
			key: spec.key,
			name: renderedName,
			id: existing.id,
			action: "updated",
		});
	}
}

function overwriteSatisfied(
	existing: ManageableOverwrite | undefined,
	allow: string[],
	deny: string[],
): boolean {
	if (!existing) return allow.length === 0 && deny.length === 0;
	const existingAllow = existing.allow.toArray?.().sort();
	const existingDeny = existing.deny.toArray?.().sort();
	if (!existingAllow || !existingDeny) return false;
	return (
		existingAllow.join("|") === allow.join("|") &&
		existingDeny.join("|") === deny.join("|")
	);
}

function exactOverwriteOptions(
	existing: ManageableOverwrite | undefined,
	allow: string[],
	deny: string[],
): Record<string, boolean | null> {
	const options: Record<string, boolean | null> = {};
	for (const name of existing?.allow.toArray?.() ?? []) options[name] = null;
	for (const name of existing?.deny.toArray?.() ?? []) options[name] = null;
	for (const name of allow) options[name] = true;
	for (const name of deny) options[name] = false;
	return options;
}

async function reconcileOverwrites(
	context: GuildManagementContext,
	template: GuildTemplate,
	maps: ReconcileMaps,
	entries: ReceiptEntry[],
	options: ReconcileOptions,
): Promise<void> {
	const { guild } = context;
	const channelSpecs: GuildTemplateChannel[] = template.channels ?? [];
	for (const spec of channelSpecs) {
		const overwrites: GuildTemplateOverwrite[] = spec.overwrites ?? [];
		if (overwrites.length === 0) continue;
		const channelId = maps.channelIdByKey.get(spec.key);
		if (!channelId) {
			if (!options.dryRun) {
				entries.push({
					kind: "overwrite",
					key: spec.key,
					action: "skipped",
					reason: "channel was not resolved",
				});
			}
			continue;
		}
		const channel = await fetchOptionalChannel(guild, channelId);
		if (!channel?.permissionOverwrites) {
			entries.push({
				kind: "overwrite",
				key: spec.key,
				action: "skipped",
				reason: "channel does not support overwrites",
			});
			continue;
		}
		for (const overwrite of overwrites) {
			const subjectId =
				overwrite.role === "@everyone"
					? guild.roles.everyone.id
					: maps.roleIdByKey.get(overwrite.role);
			const subjectLabel = `${spec.key}/${overwrite.role}`;
			if (!subjectId) {
				entries.push({
					kind: "overwrite",
					key: subjectLabel,
					action: "skipped",
					reason: `role key "${overwrite.role}" was not resolved`,
				});
				continue;
			}
			const allow = normalizePermissionList(
				overwrite.allow,
				`template overwrite ${subjectLabel} allow`,
			);
			const deny = normalizePermissionList(
				overwrite.deny,
				`template overwrite ${subjectLabel} deny`,
			);
			requirePermissionSubset(
				guild,
				allow,
				`template overwrite ${subjectLabel} allow`,
			);
			const existing = channel.permissionOverwrites.cache.get(subjectId);
			if (overwriteSatisfied(existing, allow, deny)) {
				entries.push({
					kind: "overwrite",
					key: subjectLabel,
					id: subjectId,
					action: "unchanged",
				});
				continue;
			}
			if (options.dryRun) {
				entries.push({
					kind: "overwrite",
					key: subjectLabel,
					id: subjectId,
					action: "would_update",
				});
				continue;
			}
			const optionsMap = exactOverwriteOptions(existing, allow, deny);
			await channel.permissionOverwrites.edit(subjectId, optionsMap, {
				reason: options.reason,
			});
			entries.push({
				kind: "overwrite",
				key: subjectLabel,
				id: subjectId,
				action: "updated",
			});
		}
	}
}
