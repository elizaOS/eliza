/**
 * Publishes conservative capability families and the mechanically audited
 * first-party connector handoff list. Runtime negotiation uses materialized
 * account/target profiles, never this source-name catalog.
 */

import { ElizaError } from "../../errors";
import type { TargetInfo } from "../../types/messaging";
import {
	createConnectorInteractionCapabilityProfile,
	type InteractionProfileTemplate,
	renderInteractionCapabilityMatrix,
} from "./profiles";

const TTL = 15 * 60 * 1_000;

export const CONVERSATIONAL_INTERACTION_PROFILE: InteractionProfileTemplate = {
	templateId: "conversational-v1",
	blocks: {
		choice: {
			modes: ["conversational", "signed-hosted"],
			maxSessionTtlMs: TTL,
		},
		form: { modes: ["conversational", "signed-hosted"], maxSessionTtlMs: TTL },
		followups: { modes: ["conversational"], maxSessionTtlMs: TTL },
		task: {
			modes: ["signed-hosted", "conversational"],
			maxSessionTtlMs: 24 * TTL,
		},
		secret: { modes: ["sensitive-request"], maxSessionTtlMs: TTL },
	},
	limits: {
		buttons: {
			supported: false,
			maxPerRow: 0,
			maxPerMessage: 0,
			maxLabelBytes: 0,
			maxCallbackBytes: 0,
		},
		lists: {
			supported: false,
			maxItems: 0,
			maxLabelBytes: 0,
			maxDescriptionBytes: 0,
		},
		modals: { supported: false, maxFields: 0, maxTitleBytes: 0 },
		forms: { supported: false, maxFields: 0, maxOptionsPerField: 0 },
		links: { supported: true, maxUrlBytes: 2_048 },
		edits: { supported: false, windowMs: null },
		threads: { supported: false, maxTitleBytes: 0 },
		text: { maxMessageBytes: 4_000 },
		attachments: {
			supported: false,
			maxCount: 0,
			maxBytesEach: 0,
			mimeTypes: [],
		},
	},
	nonSecretFallbacks: ["conversational", "signed-hosted"],
};

/** Text-first transports that also accept one native file attachment. */
export const CONVERSATIONAL_MEDIA_INTERACTION_PROFILE: InteractionProfileTemplate =
	{
		...CONVERSATIONAL_INTERACTION_PROFILE,
		templateId: "conversational-media-v1",
		limits: {
			...CONVERSATIONAL_INTERACTION_PROFILE.limits,
			attachments: {
				supported: true,
				maxCount: 1,
				maxBytesEach: 50 * 1024 * 1024,
				mimeTypes: ["*/*"],
			},
		},
	};

export const BUTTON_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...CONVERSATIONAL_INTERACTION_PROFILE,
	templateId: "button-native-v1",
	blocks: {
		...CONVERSATIONAL_INTERACTION_PROFILE.blocks,
		choice: {
			modes: ["native", "conversational", "signed-hosted"],
			maxSessionTtlMs: TTL,
		},
		followups: { modes: ["native", "conversational"], maxSessionTtlMs: TTL },
		task: {
			modes: ["native", "signed-hosted", "conversational"],
			maxSessionTtlMs: 24 * TTL,
		},
	},
	limits: {
		...CONVERSATIONAL_INTERACTION_PROFILE.limits,
		buttons: {
			supported: true,
			maxPerRow: 5,
			maxPerMessage: 25,
			maxLabelBytes: 80,
			maxCallbackBytes: 64,
		},
		links: { supported: true, maxUrlBytes: 2_048 },
		text: { maxMessageBytes: 4_000 },
	},
	nonSecretFallbacks: ["native", "conversational", "signed-hosted"],
};

/** Discord's documented message-component and message-size boundaries. */
export const DISCORD_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...BUTTON_INTERACTION_PROFILE,
	templateId: "discord-native-v1",
	limits: {
		...BUTTON_INTERACTION_PROFILE.limits,
		buttons: {
			supported: true,
			maxPerRow: 5,
			maxPerMessage: 25,
			maxLabelBytes: 80,
			maxCallbackBytes: 100,
		},
		text: { maxMessageBytes: 2_000 },
		attachments: {
			supported: true,
			maxCount: 10,
			maxBytesEach: 10_000_000,
			mimeTypes: ["*/*"],
		},
	},
};

/** Telegram Bot API inline-keyboard and message boundaries. */
export const TELEGRAM_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...BUTTON_INTERACTION_PROFILE,
	templateId: "telegram-native-v1",
	limits: {
		...BUTTON_INTERACTION_PROFILE.limits,
		buttons: {
			supported: true,
			maxPerRow: 8,
			maxPerMessage: 100,
			maxLabelBytes: 64,
			maxCallbackBytes: 64,
		},
		threads: { supported: true, maxTitleBytes: 128 },
		text: { maxMessageBytes: 4_096 },
		attachments: {
			supported: true,
			maxCount: 10,
			maxBytesEach: 20_000_000,
			mimeTypes: ["*/*"],
		},
	},
};

/** Slack Block Kit actions used by outbound messages. */
export const SLACK_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...BUTTON_INTERACTION_PROFILE,
	templateId: "slack-native-v1",
	limits: {
		...BUTTON_INTERACTION_PROFILE.limits,
		buttons: {
			supported: true,
			maxPerRow: 5,
			maxPerMessage: 25,
			maxLabelBytes: 75,
			maxCallbackBytes: 2_000,
		},
		edits: { supported: true, windowMs: null },
		threads: { supported: true, maxTitleBytes: 255 },
		text: { maxMessageBytes: 40_000 },
		attachments: {
			supported: true,
			maxCount: 10,
			maxBytesEach: 20_000_000,
			mimeTypes: ["*/*"],
		},
	},
};

/** WhatsApp interactive reply/list messages; forms remain conversational. */
export const WHATSAPP_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...BUTTON_INTERACTION_PROFILE,
	templateId: "whatsapp-native-v1",
	blocks: {
		...BUTTON_INTERACTION_PROFILE.blocks,
		task: {
			modes: ["conversational", "signed-hosted"],
			maxSessionTtlMs: 24 * TTL,
		},
	},
	limits: {
		...BUTTON_INTERACTION_PROFILE.limits,
		buttons: {
			supported: true,
			maxPerRow: 3,
			maxPerMessage: 3,
			maxLabelBytes: 20,
			maxCallbackBytes: 200,
		},
		lists: {
			supported: true,
			maxItems: 10,
			maxLabelBytes: 24,
			maxDescriptionBytes: 72,
		},
		text: { maxMessageBytes: 4_096 },
		attachments: {
			supported: true,
			maxCount: 1,
			maxBytesEach: 16_000_000,
			mimeTypes: ["*/*"],
		},
	},
};

/** WhatsApp Baileys has media delivery but no supported interactive payload. */
export const WHATSAPP_CONVERSATIONAL_INTERACTION_PROFILE: InteractionProfileTemplate =
	{
		...CONVERSATIONAL_INTERACTION_PROFILE,
		templateId: "whatsapp-conversational-v1",
		limits: {
			...CONVERSATIONAL_INTERACTION_PROFILE.limits,
			text: { maxMessageBytes: 4_096 },
			attachments: {
				supported: true,
				maxCount: 1,
				maxBytesEach: 16_000_000,
				mimeTypes: ["*/*"],
			},
		},
	};

export const RICH_INTERACTION_PROFILE: InteractionProfileTemplate = {
	...BUTTON_INTERACTION_PROFILE,
	templateId: "rich-native-v1",
	blocks: {
		choice: {
			modes: ["native", "signed-hosted", "conversational"],
			maxSessionTtlMs: TTL,
		},
		form: {
			modes: ["native", "signed-hosted", "conversational"],
			maxSessionTtlMs: TTL,
		},
		followups: { modes: ["native", "conversational"], maxSessionTtlMs: TTL },
		task: {
			modes: ["native", "signed-hosted", "conversational"],
			maxSessionTtlMs: 24 * TTL,
		},
		secret: { modes: ["sensitive-request"], maxSessionTtlMs: TTL },
	},
	limits: {
		buttons: {
			supported: true,
			maxPerRow: 8,
			maxPerMessage: 100,
			maxLabelBytes: 256,
			maxCallbackBytes: 256,
		},
		lists: {
			supported: true,
			maxItems: 100,
			maxLabelBytes: 256,
			maxDescriptionBytes: 1_024,
		},
		modals: { supported: true, maxFields: 20, maxTitleBytes: 256 },
		forms: { supported: true, maxFields: 20, maxOptionsPerField: 100 },
		links: { supported: true, maxUrlBytes: 8_192 },
		edits: { supported: true, windowMs: null },
		threads: { supported: true, maxTitleBytes: 256 },
		text: { maxMessageBytes: 1_000_000 },
		attachments: {
			supported: true,
			maxCount: 20,
			maxBytesEach: 100_000_000,
			mimeTypes: ["*/*"],
		},
	},
	nonSecretFallbacks: ["native", "signed-hosted", "conversational"],
};

export type FirstPartyInteractionProfileFamily =
	| "button-native"
	| "discord-native"
	| "slack-native"
	| "telegram-native"
	| "whatsapp-native"
	| "conversational-media"
	| "conversational";

export interface FirstPartyInteractionConnectorAuditEntry {
	plugin: string;
	source: string;
	targetKind: string;
	profileFamily: FirstPartyInteractionProfileFamily;
	note: string;
}

/**
 * Production `registerMessageConnector` declarations as of this contract.
 * #24288 replaces conservative families with live adapter declarations.
 */
export const FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT = [
	{
		plugin: "plugin-discord",
		source: "discord",
		targetKind: "channel",
		profileFamily: "discord-native",
		note: "native action-row buttons with conversational form fallback",
	},
	{
		plugin: "plugin-google-workspace",
		source: "gmail",
		targetKind: "email",
		profileFamily: "conversational",
		note: "email target",
	},
	{
		plugin: "plugin-google-workspace",
		source: "google-chat",
		targetKind: "room",
		profileFamily: "conversational-media",
		note: "chat spaces, threads, and one uploaded attachment",
	},
	{
		plugin: "plugin-imessage",
		source: "imessage",
		targetKind: "user",
		profileFamily: "conversational-media",
		note: "semantic text controls and one native attachment",
	},
	{
		plugin: "plugin-instagram",
		source: "instagram",
		targetKind: "thread",
		profileFamily: "conversational",
		note: "existing DM threads",
	},
	{
		plugin: "plugin-matrix",
		source: "matrix",
		targetKind: "room",
		profileFamily: "conversational",
		note: "rooms and threads",
	},
	{
		plugin: "plugin-slack",
		source: "slack",
		targetKind: "channel",
		profileFamily: "slack-native",
		note: "native Block Kit actions with conversational form fallback",
	},
	{
		plugin: "plugin-telegram",
		source: "telegram",
		targetKind: "room",
		profileFamily: "telegram-native",
		note: "native inline keyboards with conversational form fallback",
	},
	{
		plugin: "plugin-wechat",
		source: "wechat",
		targetKind: "room",
		profileFamily: "conversational",
		note: "users and groups",
	},
	{
		plugin: "plugin-whatsapp",
		source: "whatsapp",
		targetKind: "phone",
		profileFamily: "whatsapp-native",
		note: "native reply buttons/lists with conversational form/task fallback",
	},
	{
		plugin: "plugin-x",
		source: "x",
		targetKind: "user",
		profileFamily: "conversational",
		note: "direct messages only; posts are separate",
	},
] as const satisfies readonly FirstPartyInteractionConnectorAuditEntry[];

/** Deliberate non-registration that the audit must keep visible. */
export const FIRST_PARTY_INTERACTION_CONNECTOR_EXCLUSIONS = [
	{
		plugin: "plugin-signal",
		reason:
			"Signal is intentionally unsupported and throws SIGNAL_DIRECT_TRANSPORT_UNAVAILABLE; it registers no message connector.",
	},
] as const;

const PROFILE_BY_FAMILY: Record<
	FirstPartyInteractionProfileFamily,
	InteractionProfileTemplate
> = {
	"button-native": BUTTON_INTERACTION_PROFILE,
	"discord-native": DISCORD_INTERACTION_PROFILE,
	"slack-native": SLACK_INTERACTION_PROFILE,
	"telegram-native": TELEGRAM_INTERACTION_PROFILE,
	"whatsapp-native": WHATSAPP_INTERACTION_PROFILE,
	"conversational-media": CONVERSATIONAL_MEDIA_INTERACTION_PROFILE,
	conversational: CONVERSATIONAL_INTERACTION_PROFILE,
};

/** Materialize the audited declaration for one production connector target. */
export function createFirstPartyInteractionProfile(args: {
	source: string;
	accountId: string;
	targetKind: string;
	targetId: string;
}) {
	const entry = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.find(
		(candidate) => candidate.source === args.source,
	);
	if (!entry) {
		throw new Error(
			`No audited first-party interaction profile for ${args.source}.`,
		);
	}
	return createConnectorInteractionCapabilityProfile({
		template: PROFILE_BY_FAMILY[entry.profileFamily],
		...args,
	});
}

function firstTargetIdentity(target: TargetInfo): string | undefined {
	const values = [
		target.channelId,
		target.entityId,
		target.roomId,
		target.serverId,
	]
		.map((value) => (value === undefined ? "" : String(value).trim()))
		.filter(Boolean);
	if (target.threadId?.trim()) {
		const parent = values[0];
		return parent
			? `${parent}:thread:${target.threadId.trim()}`
			: target.threadId.trim();
	}
	return values[0];
}

/**
 * Materialize a connector's audited profile without trusting caller metadata to
 * invent an account or target identity. Registrations pass their own fixed
 * source and default target kind; the concrete target remains part of the ID.
 */
export function resolveFirstPartyInteractionProfile(args: {
	source: string;
	defaultAccountId: string;
	defaultTargetKind: string;
	target: TargetInfo;
	accountId?: string;
}) {
	const accountId =
		args.accountId?.trim() ||
		args.target.accountId?.trim() ||
		args.defaultAccountId;
	if (!accountId.trim()) {
		throw new ElizaError(
			"Interaction account has no trusted connector identity.",
			{
				code: "INTERACTION_ACCOUNT_IDENTITY_MISSING",
				context: { source: args.source },
			},
		);
	}
	const targetId = firstTargetIdentity(args.target);
	if (!targetId) {
		throw new ElizaError(
			"Interaction target has no stable provider identity.",
			{
				code: "INTERACTION_TARGET_IDENTITY_MISSING",
				context: { source: args.source },
			},
		);
	}
	return createFirstPartyInteractionProfile({
		source: args.source,
		accountId,
		targetKind: args.target.threadId ? "thread" : args.defaultTargetKind,
		targetId,
	});
}

/** Deterministic handoff artifact for connector implementers and reviewers. */
export function renderFirstPartyInteractionCapabilityMatrix(): string {
	const profiles = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.map((entry) =>
		createConnectorInteractionCapabilityProfile({
			template: PROFILE_BY_FAMILY[entry.profileFamily],
			source: entry.source,
			accountId: "<account>",
			targetKind: entry.targetKind,
			targetId: "<target>",
		}),
	);
	return [
		"# First-party interaction capability baseline",
		"",
		"This generated matrix is the production declaration. Each runtime registration materializes the family for its concrete account and target; native claims are backed by adapter tests and every other block has an explicit semantic fallback.",
		"",
		renderInteractionCapabilityMatrix(profiles),
		"",
		"## Explicit exclusions",
		"",
		...FIRST_PARTY_INTERACTION_CONNECTOR_EXCLUSIONS.map(
			(entry) => `- ${entry.plugin}: ${entry.reason}`,
		),
	].join("\n");
}
