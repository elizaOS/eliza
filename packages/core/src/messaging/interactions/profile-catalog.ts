/**
 * Publishes conservative capability families and the mechanically audited
 * first-party connector handoff list. Runtime negotiation uses materialized
 * account/target profiles, never this source-name catalog.
 */

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
	| "conversational"
	| "read-only";

export interface FirstPartyInteractionConnectorAuditEntry {
	plugin: string;
	registrationSite: string;
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
		registrationSite: "plugin-discord/service.ts",
		source: "discord",
		targetKind: "channel",
		profileFamily: "button-native",
		note: "native buttons already exist",
	},
	{
		plugin: "plugin-google-workspace",
		registrationSite: "plugin-google-workspace/src/chat/service.ts",
		source: "gmail",
		targetKind: "email",
		profileFamily: "conversational",
		note: "email target",
	},
	{
		plugin: "plugin-google-workspace",
		registrationSite: "plugin-google-workspace/src/chat/service.ts",
		source: "google-chat",
		targetKind: "room",
		profileFamily: "conversational",
		note: "chat spaces and threads",
	},
	{
		plugin: "plugin-imessage",
		registrationSite: "plugin-imessage/src/service.ts",
		source: "imessage",
		targetKind: "user",
		profileFamily: "conversational",
		note: "text and attachment transport",
	},
	{
		plugin: "plugin-slack",
		registrationSite: "plugin-slack/src/service.ts",
		source: "slack",
		targetKind: "channel",
		profileFamily: "conversational",
		note: "channels, threads, users",
	},
	{
		plugin: "plugin-telegram",
		registrationSite: "plugin-telegram/src/account-client-service.ts",
		source: "telegram",
		targetKind: "user",
		profileFamily: "read-only",
		note: "personal account history and search; no outbound interaction transport",
	},
	{
		plugin: "plugin-telegram",
		registrationSite: "plugin-telegram/src/account-client-service.ts",
		source: "telegram",
		targetKind: "channel",
		profileFamily: "read-only",
		note: "personal account history and search; no outbound interaction transport",
	},
	{
		plugin: "plugin-telegram",
		registrationSite: "plugin-telegram/src/account-client-service.ts",
		source: "telegram",
		targetKind: "thread",
		profileFamily: "read-only",
		note: "personal account history and search; no outbound interaction transport",
	},
	{
		plugin: "plugin-telegram",
		registrationSite: "plugin-telegram/src/service.ts",
		source: "telegram",
		targetKind: "room",
		profileFamily: "button-native",
		note: "inline keyboard already exists",
	},
	{
		plugin: "plugin-x",
		registrationSite: "plugin-x/src/services/x.service.ts",
		source: "x",
		targetKind: "user",
		profileFamily: "conversational",
		note: "direct messages only; posts are separate",
	},
] as const satisfies readonly FirstPartyInteractionConnectorAuditEntry[];

/** Deterministic handoff artifact for connector implementers and reviewers. */
export function renderFirstPartyInteractionCapabilityMatrix(): string {
	const profiles = FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
		(entry) => entry.profileFamily !== "read-only",
	).map((entry) =>
		createConnectorInteractionCapabilityProfile({
			template:
				entry.profileFamily === "button-native"
					? BUTTON_INTERACTION_PROFILE
					: CONVERSATIONAL_INTERACTION_PROFILE,
			source: entry.source,
			accountId: "<account>",
			targetKind: entry.targetKind,
			targetId: "<target>",
		}),
	);
	return [
		"# First-party interaction capability baseline",
		"",
		"This generated baseline is conservative. Each runtime registration materializes the family for its concrete account and target; #24288 may advertise stronger limits only with adapter tests.",
		"",
		renderInteractionCapabilityMatrix(profiles),
		"",
		"## Read-only registrations",
		"",
		"These registrations expose history and search only. They cannot deliver interaction blocks or collect replies through this connector.",
		"",
		"| Connector | Registration | Target | Outbound interaction delivery |",
		"| --- | --- | --- | --- |",
		...FIRST_PARTY_INTERACTION_CONNECTOR_AUDIT.filter(
			(entry) => entry.profileFamily === "read-only",
		).map(
			(entry) =>
				`| ${entry.source} | ${entry.registrationSite} | ${entry.targetKind}:<target> | unsupported |`,
		),
	].join("\n");
}
