/**
 * Declarative guild templates for the Discord connector's structural
 * management surface (`guild-management.ts`).
 *
 * A template is a vendor-neutral, idempotent guild spec: roles first (so
 * permission overwrites can reference them), then categories, then channels.
 * Objects are matched by stable `key` (via a persisted key->snowflake map)
 * with an exact-name fallback, so re-applying a template converges instead of
 * duplicating, and NEVER deletes anything it does not manage.
 *
 * Deployments can extend or override the built-in registry through
 * `settings.discord.guildTemplates` (per-account override via
 * `settings.discord.accounts.<id>.guildTemplates`).
 */

export interface GuildTemplateRole {
	/** Stable identity for reconcile. Never rendered to Discord. */
	key: string;
	name: string;
	/** Hex color, e.g. "#E4C340". */
	color?: string;
	hoist?: boolean;
	mentionable?: boolean;
	/**
	 * Named Discord permissions (PascalCase or SCREAMING_SNAKE). Administrator
	 * is always rejected — templates cannot mint an admin bypass.
	 */
	permissions?: string[];
}

export interface GuildTemplateCategory {
	key: string;
	name: string;
}

export interface GuildTemplateOverwrite {
	/** Role `key` from this template, or the literal "@everyone". */
	role: string;
	allow?: string[];
	deny?: string[];
}

export type GuildTemplateChannelType =
	| "text"
	| "voice"
	| "announcement"
	| "forum"
	| "stage";

export interface GuildTemplateChannel {
	key: string;
	name: string;
	/** Defaults to "text". */
	type?: GuildTemplateChannelType;
	/** Category `key` from this template. */
	parent?: string;
	topic?: string;
	overwrites?: GuildTemplateOverwrite[];
}

export interface GuildTemplate {
	id: string;
	version?: number;
	description?: string;
	roles?: GuildTemplateRole[];
	categories?: GuildTemplateCategory[];
	channels?: GuildTemplateChannel[];
}

/** Bounded template sizes — reject anything larger before touching Discord. */
export const GUILD_TEMPLATE_LIMITS = {
	maxRoles: 50,
	maxCategories: 50,
	maxChannels: 200,
	maxOverwritesPerChannel: 25,
	maxNameLength: 100,
	maxTopicLength: 1024,
	maxPermissionEntries: 40,
} as const;

const AGENT_ROLE_PERMISSIONS = [
	"ViewChannel",
	"SendMessages",
	"ManageMessages",
	"EmbedLinks",
	"AttachFiles",
	"ReadMessageHistory",
	"AddReactions",
	"ManageThreads",
	"CreatePublicThreads",
	"SendMessagesInThreads",
	"UseApplicationCommands",
];

/**
 * Strong management set WITHOUT Administrator. Templates never grant the
 * Administrator bypass; guild owners can escalate manually if they want it.
 */
const ADMIN_ROLE_PERMISSIONS = [
	"ViewChannel",
	"SendMessages",
	"ReadMessageHistory",
	"AddReactions",
	"AttachFiles",
	"EmbedLinks",
	"ManageChannels",
	"ManageRoles",
	"ManageMessages",
	"ManageThreads",
	"ManageNicknames",
	"KickMembers",
	"BanMembers",
	"ModerateMembers",
	"MentionEveryone",
	"CreateInstantInvite",
];

const MEMBER_ROLE_PERMISSIONS = [
	"ViewChannel",
	"SendMessages",
	"ReadMessageHistory",
	"AddReactions",
];

const companionPrivate: GuildTemplate = {
	id: "companion-private",
	version: 1,
	description:
		"Single owner + agent private space: locked-down chat, voice, and an agent log channel.",
	roles: [
		{
			key: "agent",
			name: "{{agent}}",
			color: "#E4C340",
			hoist: true,
			mentionable: true,
			permissions: [...AGENT_ROLE_PERMISSIONS, "Connect", "Speak"],
		},
		{
			key: "owner",
			name: "Owner",
			color: "#FFFFFF",
			hoist: true,
			permissions: ADMIN_ROLE_PERMISSIONS,
		},
	],
	categories: [{ key: "cat-home", name: "HOME" }],
	channels: [
		{
			key: "chat",
			name: "chat",
			type: "text",
			parent: "cat-home",
			topic: "private channel for the owner and the agent",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "owner", allow: ["ViewChannel", "SendMessages"] },
				{
					role: "agent",
					allow: ["ViewChannel", "SendMessages", "ManageMessages"],
				},
			],
		},
		{
			key: "voice",
			name: "voice",
			type: "voice",
			parent: "cat-home",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "owner", allow: ["ViewChannel", "Connect", "Speak"] },
				{ role: "agent", allow: ["ViewChannel", "Connect", "Speak"] },
			],
		},
		{
			key: "log",
			name: "agent-log",
			type: "text",
			parent: "cat-home",
			topic: "agent journals and receipts",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "owner", allow: ["ViewChannel"] },
				{
					role: "agent",
					allow: ["ViewChannel", "SendMessages", "ManageMessages"],
				},
			],
		},
	],
};

const friendsCasual: GuildTemplate = {
	id: "friends-casual",
	version: 1,
	description:
		"Small friends server with a shared agent: open lounge, media, and a hang voice channel.",
	roles: [
		{
			key: "agent",
			name: "{{agent}}",
			color: "#E4C340",
			hoist: true,
			mentionable: true,
			permissions: [...AGENT_ROLE_PERMISSIONS, "Connect", "Speak"],
		},
		{
			key: "friend",
			name: "Friend",
			color: "#9B59B6",
			permissions: [
				...MEMBER_ROLE_PERMISSIONS,
				"AttachFiles",
				"EmbedLinks",
				"Connect",
				"Speak",
			],
		},
	],
	categories: [{ key: "cat-hang", name: "HANG" }],
	channels: [
		{
			key: "lounge",
			name: "lounge",
			type: "text",
			parent: "cat-hang",
			topic: "whatever",
		},
		{
			key: "media",
			name: "media",
			type: "text",
			parent: "cat-hang",
			topic: "pics and links",
		},
		{ key: "vc", name: "hang-vc", type: "voice", parent: "cat-hang" },
	],
};

const projectTeam: GuildTemplate = {
	id: "project-team",
	version: 1,
	description:
		"Work team server: general, role-gated dev, agent-write receipts and alerts channels.",
	roles: [
		{
			key: "agent",
			name: "{{agent}}",
			color: "#E4C340",
			hoist: true,
			mentionable: true,
			permissions: AGENT_ROLE_PERMISSIONS,
		},
		{
			key: "admin",
			name: "Admin",
			color: "#E74C3C",
			hoist: true,
			permissions: ADMIN_ROLE_PERMISSIONS,
		},
		{
			key: "dev",
			name: "Dev",
			color: "#1ABC9C",
			permissions: [
				...MEMBER_ROLE_PERMISSIONS,
				"AttachFiles",
				"EmbedLinks",
				"CreatePublicThreads",
				"SendMessagesInThreads",
			],
		},
		{
			key: "member",
			name: "Member",
			color: "#3498DB",
			permissions: MEMBER_ROLE_PERMISSIONS,
		},
	],
	categories: [
		{ key: "cat-team", name: "TEAM" },
		{ key: "cat-dev", name: "DEV" },
		{ key: "cat-ops", name: "OPS" },
	],
	channels: [
		{
			key: "general",
			name: "general",
			type: "text",
			parent: "cat-team",
			topic: "team-wide",
		},
		{
			key: "dev",
			name: "dev",
			type: "text",
			parent: "cat-dev",
			topic: "engineering",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "dev", allow: ["ViewChannel", "SendMessages"] },
				{ role: "admin", allow: ["ViewChannel", "SendMessages"] },
				{
					role: "agent",
					allow: ["ViewChannel", "SendMessages", "ManageMessages"],
				},
			],
		},
		{
			key: "receipts",
			name: "receipts",
			type: "text",
			parent: "cat-ops",
			topic: "agent posts build and PR receipts here",
			overwrites: [
				{
					role: "@everyone",
					allow: ["ViewChannel", "ReadMessageHistory"],
					deny: ["SendMessages"],
				},
				{ role: "agent", allow: ["SendMessages", "ManageMessages"] },
			],
		},
		{
			key: "alerts",
			name: "alerts",
			type: "text",
			parent: "cat-ops",
			topic: "CI, uptime, incidents",
			overwrites: [
				{
					role: "@everyone",
					allow: ["ViewChannel", "ReadMessageHistory"],
					deny: ["SendMessages"],
				},
				{ role: "agent", allow: ["SendMessages"] },
			],
		},
	],
};

const communityPublic: GuildTemplate = {
	id: "community-public",
	version: 1,
	description:
		"Public community: locked landing (rules + welcome), verified-gated general, mod log.",
	roles: [
		{
			key: "agent",
			name: "{{agent}}",
			color: "#E4C340",
			hoist: true,
			mentionable: true,
			permissions: [...AGENT_ROLE_PERMISSIONS, "ModerateMembers"],
		},
		{
			key: "admin",
			name: "Admin",
			color: "#E74C3C",
			hoist: true,
			permissions: ADMIN_ROLE_PERMISSIONS,
		},
		{
			key: "mod",
			name: "Mod",
			color: "#E67E22",
			hoist: true,
			permissions: [
				...MEMBER_ROLE_PERMISSIONS,
				"ManageMessages",
				"ManageThreads",
				"KickMembers",
				"ModerateMembers",
			],
		},
		{
			key: "verified",
			name: "Verified",
			color: "#2ECC71",
			permissions: [...MEMBER_ROLE_PERMISSIONS, "AttachFiles", "EmbedLinks"],
		},
	],
	categories: [
		{ key: "cat-welcome", name: "WELCOME" },
		{ key: "cat-community", name: "COMMUNITY" },
	],
	channels: [
		{
			key: "rules",
			name: "rules",
			type: "text",
			parent: "cat-welcome",
			topic: "read and react to verify",
			overwrites: [
				{
					role: "@everyone",
					allow: ["ViewChannel", "ReadMessageHistory", "AddReactions"],
					deny: ["SendMessages"],
				},
				{ role: "agent", allow: ["SendMessages", "ManageMessages"] },
			],
		},
		{
			key: "welcome",
			name: "welcome",
			type: "text",
			parent: "cat-welcome",
			topic: "greetings",
			overwrites: [
				{
					role: "@everyone",
					allow: ["ViewChannel", "ReadMessageHistory"],
					deny: ["SendMessages"],
				},
				{ role: "agent", allow: ["SendMessages"] },
			],
		},
		{
			key: "general",
			name: "general",
			type: "text",
			parent: "cat-community",
			topic: "verified members only",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "verified", allow: ["ViewChannel", "SendMessages"] },
				{
					role: "agent",
					allow: ["ViewChannel", "SendMessages", "ManageMessages"],
				},
			],
		},
		{
			key: "modlog",
			name: "mod-log",
			type: "text",
			parent: "cat-community",
			topic: "moderation audit",
			overwrites: [
				{ role: "@everyone", deny: ["ViewChannel"] },
				{ role: "mod", allow: ["ViewChannel"] },
				{ role: "admin", allow: ["ViewChannel"] },
				{ role: "agent", allow: ["ViewChannel", "SendMessages"] },
			],
		},
	],
};

export const BUILT_IN_GUILD_TEMPLATES: Readonly<Record<string, GuildTemplate>> =
	Object.freeze({
		[companionPrivate.id]: companionPrivate,
		[friendsCasual.id]: friendsCasual,
		[projectTeam.id]: projectTeam,
		[communityPublic.id]: communityPublic,
	});

/**
 * Renders `{{variable}}` placeholders in template names/topics. Unknown
 * variables render their default when provided (`agent` -> "Agent") and are
 * otherwise left intact so the drift is visible instead of silently blank.
 */
export function renderTemplateString(
	value: string,
	variables: Record<string, string>,
): string {
	return value.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, name: string) => {
		const provided = variables[name];
		if (typeof provided === "string" && provided.trim()) {
			return provided.trim();
		}
		if (name === "agent") return "Agent";
		return whole;
	});
}

/** Validates template shape and bounds. Returns human-actionable errors. */
export function validateGuildTemplate(template: GuildTemplate): string[] {
	const errors: string[] = [];
	const limits = GUILD_TEMPLATE_LIMITS;
	if (!template || typeof template !== "object" || Array.isArray(template)) {
		return ["template must be an object"];
	}
	if (typeof template.id !== "string" || !template.id.trim()) {
		errors.push("template.id is required");
	}
	if (template.roles !== undefined && !Array.isArray(template.roles)) {
		errors.push("template.roles must be an array");
	}
	if (
		template.categories !== undefined &&
		!Array.isArray(template.categories)
	) {
		errors.push("template.categories must be an array");
	}
	if (template.channels !== undefined && !Array.isArray(template.channels)) {
		errors.push("template.channels must be an array");
	}
	const roles = Array.isArray(template.roles) ? template.roles : [];
	const categories = Array.isArray(template.categories)
		? template.categories
		: [];
	const channels = Array.isArray(template.channels) ? template.channels : [];
	if (roles.length > limits.maxRoles) {
		errors.push(`template.roles exceeds ${limits.maxRoles} entries`);
	}
	if (categories.length > limits.maxCategories) {
		errors.push(`template.categories exceeds ${limits.maxCategories} entries`);
	}
	if (channels.length > limits.maxChannels) {
		errors.push(`template.channels exceeds ${limits.maxChannels} entries`);
	}
	const seenKeys = new Set<string>();
	const checkKeyedName = (
		kind: string,
		entry: unknown,
		index: number,
	): entry is { key: string; name: string } & Record<string, unknown> => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			errors.push(`${kind}[${index}] must be an object`);
			return false;
		}
		const record = entry as Record<string, unknown>;
		const key = typeof record.key === "string" ? record.key.trim() : "";
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (!key) errors.push(`${kind}[${index}].key is required`);
		if (!name) errors.push(`${kind}[${index}].name is required`);
		if (name.length > limits.maxNameLength) {
			errors.push(
				`${kind}[${index}].name exceeds ${limits.maxNameLength} characters`,
			);
		}
		const qualified = `${kind}:${key}`;
		if (key && seenKeys.has(qualified)) {
			errors.push(`duplicate ${kind} key "${key}"`);
		}
		seenKeys.add(qualified);
		return Boolean(key && name);
	};
	roles.forEach((role, index) => {
		if (!checkKeyedName("roles", role, index)) return;
		if (role.permissions !== undefined && !Array.isArray(role.permissions)) {
			errors.push(`roles[${index}].permissions must be an array`);
		} else if (
			Array.isArray(role.permissions) &&
			role.permissions.length > limits.maxPermissionEntries
		) {
			errors.push(
				`roles[${index}].permissions exceeds ${limits.maxPermissionEntries} entries`,
			);
		}
		if (
			Array.isArray(role.permissions) &&
			role.permissions.some((permission) => typeof permission !== "string")
		) {
			errors.push(`roles[${index}].permissions must contain only strings`);
		}
	});
	categories.forEach((category, index) => {
		checkKeyedName("categories", category, index);
	});
	const categoryKeys = new Set(
		categories.flatMap((category) =>
			category &&
			typeof category === "object" &&
			typeof category.key === "string"
				? [category.key]
				: [],
		),
	);
	const roleKeys = new Set(
		roles.flatMap((role) =>
			role && typeof role === "object" && typeof role.key === "string"
				? [role.key]
				: [],
		),
	);
	channels.forEach((channel, index) => {
		if (!checkKeyedName("channels", channel, index)) return;
		if (
			typeof channel.parent === "string" &&
			channel.parent &&
			!categoryKeys.has(channel.parent)
		) {
			errors.push(
				`channels[${index}].parent "${channel.parent}" is not a category key in this template`,
			);
		}
		if (
			typeof channel.topic === "string" &&
			channel.topic.length > limits.maxTopicLength
		) {
			errors.push(
				`channels[${index}].topic exceeds ${limits.maxTopicLength} characters`,
			);
		}
		if (
			channel.type !== undefined &&
			!["text", "voice", "announcement", "forum", "stage"].includes(
				String(channel.type),
			)
		) {
			errors.push(`channels[${index}].type is not supported`);
		}
		if (
			channel.overwrites !== undefined &&
			!Array.isArray(channel.overwrites)
		) {
			errors.push(`channels[${index}].overwrites must be an array`);
		}
		const overwrites = Array.isArray(channel.overwrites)
			? channel.overwrites
			: [];
		if (overwrites.length > limits.maxOverwritesPerChannel) {
			errors.push(
				`channels[${index}].overwrites exceeds ${limits.maxOverwritesPerChannel} entries`,
			);
		}
		overwrites.forEach((overwrite, overwriteIndex) => {
			if (
				!overwrite ||
				typeof overwrite !== "object" ||
				Array.isArray(overwrite)
			) {
				errors.push(
					`channels[${index}].overwrites[${overwriteIndex}] must be an object`,
				);
				return;
			}
			if (typeof overwrite.role !== "string" || !overwrite.role.trim()) {
				errors.push(
					`channels[${index}].overwrites[${overwriteIndex}].role is required`,
				);
				return;
			}
			if (overwrite.role !== "@everyone" && !roleKeys.has(overwrite.role)) {
				errors.push(
					`channels[${index}].overwrites[${overwriteIndex}].role "${overwrite.role}" is not a role key in this template`,
				);
			}
			for (const field of ["allow", "deny"] as const) {
				const permissions = overwrite[field];
				if (permissions !== undefined && !Array.isArray(permissions)) {
					errors.push(
						`channels[${index}].overwrites[${overwriteIndex}].${field} must be an array`,
					);
				} else if (
					Array.isArray(permissions) &&
					(permissions.length > limits.maxPermissionEntries ||
						permissions.some((permission) => typeof permission !== "string"))
				) {
					errors.push(
						`channels[${index}].overwrites[${overwriteIndex}].${field} must contain at most ${limits.maxPermissionEntries} strings`,
					);
				}
			}
		});
	});
	return errors;
}
