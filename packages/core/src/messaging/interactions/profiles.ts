/**
 * Defines the provider-neutral capability profile negotiated for one concrete
 * connector account and target. Rendering code consumes this profile directly;
 * connector names are deliberately absent from the runtime decision path.
 */

import { ElizaError } from "../../errors";
import type {
	InteractionBlock,
	InteractionKind,
} from "../../types/interactions";
import { stringToUuid } from "../../utils";
import { stableStringify } from "../../utils/deterministic";

export const INTERACTION_PROFILE_VERSION = 1 as const;
export const INTERACTION_BLOCK_KINDS = [
	"choice",
	"form",
	"followups",
	"task",
	"secret",
] as const satisfies readonly InteractionKind[];

export type InteractionDeliveryMode =
	| "native"
	| "conversational"
	| "signed-hosted"
	| "sensitive-request";

const INTERACTION_DELIVERY_MODES = new Set<InteractionDeliveryMode>([
	"native",
	"conversational",
	"signed-hosted",
	"sensitive-request",
]);

export interface InteractionPrimitiveLimits {
	buttons: {
		supported: boolean;
		maxPerRow: number;
		maxPerMessage: number;
		maxLabelBytes: number;
		maxCallbackBytes: number;
	};
	lists: {
		supported: boolean;
		maxItems: number;
		maxLabelBytes: number;
		maxDescriptionBytes: number;
	};
	modals: {
		supported: boolean;
		maxFields: number;
		maxTitleBytes: number;
	};
	forms: {
		supported: boolean;
		maxFields: number;
		maxOptionsPerField: number;
	};
	links: {
		supported: boolean;
		maxUrlBytes: number;
	};
	edits: {
		supported: boolean;
		windowMs: number | null;
	};
	threads: {
		supported: boolean;
		maxTitleBytes: number;
	};
	text: {
		maxMessageBytes: number;
	};
	attachments: {
		supported: boolean;
		maxCount: number;
		maxBytesEach: number;
		mimeTypes: readonly string[];
	};
}

export interface InteractionBlockCapability {
	modes: readonly InteractionDeliveryMode[];
	/** Maximum lifetime for a callback rendered from this block. */
	maxSessionTtlMs: number;
}

export interface ConnectorInteractionCapabilityProfile {
	profileVersion: typeof INTERACTION_PROFILE_VERSION;
	profileId: string;
	connector: { source: string; accountId: string };
	target: { kind: string; id: string };
	blocks: Record<InteractionKind, InteractionBlockCapability>;
	limits: InteractionPrimitiveLimits;
	/** Ordered, actionable degradation paths for non-secret input. */
	nonSecretFallbacks: readonly Exclude<
		InteractionDeliveryMode,
		"sensitive-request"
	>[];
	/** Secret and OAuth collection is never allowed through ordinary chat data. */
	sensitiveFallback: "sensitive-request";
}

export interface InteractionProfileTemplate {
	templateId: string;
	blocks: Record<InteractionKind, InteractionBlockCapability>;
	limits: InteractionPrimitiveLimits;
	nonSecretFallbacks: ConnectorInteractionCapabilityProfile["nonSecretFallbacks"];
}

function positiveInteger(value: number, path: string): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new ElizaError(`${path} must be a positive safe integer.`, {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
			context: { path, value },
		});
	}
}

function supportedLimit(supported: boolean, value: number, path: string): void {
	if (supported) {
		positiveInteger(value, path);
		return;
	}
	if (value !== 0) {
		throw new ElizaError(`${path} must be zero when unsupported.`, {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
			context: { path, value },
		});
	}
}

function nonEmpty(value: string, path: string): string {
	const normalized = value.trim();
	if (!normalized) {
		throw new ElizaError(`${path} must not be blank.`, {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
			context: { path },
		});
	}
	return normalized;
}

/** Validate and defensively copy one complete per-account/target profile. */
export function normalizeConnectorInteractionCapabilityProfile(
	profile: ConnectorInteractionCapabilityProfile,
): ConnectorInteractionCapabilityProfile {
	if (profile.profileVersion !== INTERACTION_PROFILE_VERSION) {
		throw new ElizaError("Unsupported interaction profile version.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
			context: { profileVersion: profile.profileVersion },
		});
	}
	for (const kind of INTERACTION_BLOCK_KINDS) {
		const capability = profile.blocks[kind];
		if (!capability || capability.modes.length === 0) {
			throw new ElizaError(`Interaction profile omits ${kind}.`, {
				code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
				context: { kind },
			});
		}
		if (
			capability.modes.some((mode) => !INTERACTION_DELIVERY_MODES.has(mode))
		) {
			throw new ElizaError(`Interaction profile has an unknown ${kind} mode.`, {
				code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
				context: { kind },
			});
		}
		positiveInteger(
			capability.maxSessionTtlMs,
			`blocks.${kind}.maxSessionTtlMs`,
		);
		if (new Set(capability.modes).size !== capability.modes.length) {
			throw new ElizaError(`Interaction profile repeats a ${kind} mode.`, {
				code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
				context: { kind },
			});
		}
		if (
			kind === "secret" &&
			(capability.modes.length !== 1 ||
				capability.modes[0] !== "sensitive-request")
		) {
			throw new ElizaError(
				"Secret interactions must use only the sensitive-request flow.",
				{ code: "INVALID_INTERACTION_CAPABILITY_PROFILE", context: { kind } },
			);
		}
		if (kind !== "secret" && capability.modes.includes("sensitive-request")) {
			throw new ElizaError(
				"Ordinary interaction blocks cannot use the sensitive-request mode.",
				{ code: "INVALID_INTERACTION_CAPABILITY_PROFILE", context: { kind } },
			);
		}
	}
	const limits = profile.limits;
	supportedLimit(
		limits.buttons.supported,
		limits.buttons.maxPerRow,
		"limits.buttons.maxPerRow",
	);
	if (
		limits.buttons.supported &&
		limits.buttons.maxPerRow > limits.buttons.maxPerMessage
	) {
		throw new ElizaError(
			"Button row limit cannot exceed the message button limit.",
			{ code: "INVALID_INTERACTION_CAPABILITY_PROFILE" },
		);
	}
	supportedLimit(
		limits.buttons.supported,
		limits.buttons.maxPerMessage,
		"limits.buttons.maxPerMessage",
	);
	supportedLimit(
		limits.buttons.supported,
		limits.buttons.maxLabelBytes,
		"limits.buttons.maxLabelBytes",
	);
	supportedLimit(
		limits.buttons.supported,
		limits.buttons.maxCallbackBytes,
		"limits.buttons.maxCallbackBytes",
	);
	supportedLimit(
		limits.lists.supported,
		limits.lists.maxItems,
		"limits.lists.maxItems",
	);
	supportedLimit(
		limits.lists.supported,
		limits.lists.maxLabelBytes,
		"limits.lists.maxLabelBytes",
	);
	supportedLimit(
		limits.lists.supported,
		limits.lists.maxDescriptionBytes,
		"limits.lists.maxDescriptionBytes",
	);
	supportedLimit(
		limits.modals.supported,
		limits.modals.maxFields,
		"limits.modals.maxFields",
	);
	supportedLimit(
		limits.modals.supported,
		limits.modals.maxTitleBytes,
		"limits.modals.maxTitleBytes",
	);
	supportedLimit(
		limits.forms.supported,
		limits.forms.maxFields,
		"limits.forms.maxFields",
	);
	supportedLimit(
		limits.forms.supported,
		limits.forms.maxOptionsPerField,
		"limits.forms.maxOptionsPerField",
	);
	supportedLimit(
		limits.links.supported,
		limits.links.maxUrlBytes,
		"limits.links.maxUrlBytes",
	);
	if (
		limits.edits.windowMs !== null &&
		(!Number.isSafeInteger(limits.edits.windowMs) || limits.edits.windowMs < 1)
	) {
		throw new ElizaError("limits.edits.windowMs is invalid.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (!limits.edits.supported && limits.edits.windowMs !== null) {
		throw new ElizaError("Unsupported edits must not declare a time window.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	supportedLimit(
		limits.threads.supported,
		limits.threads.maxTitleBytes,
		"limits.threads.maxTitleBytes",
	);
	positiveInteger(limits.text.maxMessageBytes, "limits.text.maxMessageBytes");
	supportedLimit(
		limits.attachments.supported,
		limits.attachments.maxCount,
		"limits.attachments.maxCount",
	);
	supportedLimit(
		limits.attachments.supported,
		limits.attachments.maxBytesEach,
		"limits.attachments.maxBytesEach",
	);
	if (
		!limits.attachments.supported &&
		limits.attachments.mimeTypes.length > 0
	) {
		throw new ElizaError("Unsupported attachments cannot declare MIME types.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (
		profile.blocks.choice.modes.includes("native") &&
		!limits.buttons.supported &&
		!limits.lists.supported
	) {
		throw new ElizaError("Native choices require buttons or lists.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (
		profile.blocks.followups.modes.includes("native") &&
		!limits.buttons.supported
	) {
		throw new ElizaError("Native followups require buttons.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (
		profile.blocks.form.modes.includes("native") &&
		(!limits.forms.supported || !limits.modals.supported)
	) {
		throw new ElizaError("Native forms require form and modal primitives.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (
		profile.blocks.task.modes.includes("native") &&
		!limits.links.supported &&
		!limits.threads.supported
	) {
		throw new ElizaError("Native tasks require links or threads.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (profile.nonSecretFallbacks.length === 0) {
		throw new ElizaError("A non-secret fallback is required.", {
			code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
		});
	}
	if (
		new Set(profile.nonSecretFallbacks).size !==
			profile.nonSecretFallbacks.length ||
		profile.nonSecretFallbacks.some(
			(mode) => !INTERACTION_DELIVERY_MODES.has(mode),
		)
	) {
		throw new ElizaError(
			"Non-secret interaction fallbacks must be unique known modes.",
			{ code: "INVALID_INTERACTION_CAPABILITY_PROFILE" },
		);
	}
	for (const kind of INTERACTION_BLOCK_KINDS) {
		if (kind === "secret") continue;
		if (
			profile.blocks[kind].modes.some(
				(mode) =>
					mode === "sensitive-request" ||
					!profile.nonSecretFallbacks.includes(mode),
			)
		) {
			throw new ElizaError(
				`${kind} declares a mode missing from non-secret fallbacks.`,
				{
					code: "INVALID_INTERACTION_CAPABILITY_PROFILE",
					context: { kind },
				},
			);
		}
	}
	return structuredClone({
		...profile,
		profileId: nonEmpty(profile.profileId, "profileId"),
		connector: {
			source: nonEmpty(profile.connector.source, "connector.source"),
			accountId: nonEmpty(profile.connector.accountId, "connector.accountId"),
		},
		target: {
			kind: nonEmpty(profile.target.kind, "target.kind"),
			id: nonEmpty(profile.target.id, "target.id"),
		},
	});
}

/** Materialize a template for exactly one connector account and target. */
export function createConnectorInteractionCapabilityProfile(args: {
	template: InteractionProfileTemplate;
	source: string;
	accountId: string;
	targetKind: string;
	targetId: string;
}): ConnectorInteractionCapabilityProfile {
	const templateId = nonEmpty(args.template.templateId, "template.templateId");
	const source = nonEmpty(args.source, "connector.source");
	const accountId = nonEmpty(args.accountId, "connector.accountId");
	const targetKind = nonEmpty(args.targetKind, "target.kind");
	const targetId = nonEmpty(args.targetId, "target.id");
	return normalizeConnectorInteractionCapabilityProfile({
		profileVersion: INTERACTION_PROFILE_VERSION,
		profileId: `ip1:${stringToUuid(`${INTERACTION_PROFILE_VERSION}:${templateId}:${source}:${accountId}:${targetKind}:${targetId}`)}`,
		connector: { source, accountId },
		target: { kind: targetKind, id: targetId },
		blocks: args.template.blocks,
		limits: args.template.limits,
		nonSecretFallbacks: args.template.nonSecretFallbacks,
		sensitiveFallback: "sensitive-request",
	});
}

export interface NegotiatedInteractionDelivery {
	mode: InteractionDeliveryMode;
	reason: "preferred" | "native-limit" | "native-unavailable" | "sensitive";
	limitations: readonly string[];
}

export interface InteractionNegotiationContext {
	callbackBytes?: number;
	buttonsPerRow?: number;
	signedHostedUrl?: string;
	requiresEdit?: boolean;
	sourceMessageCreatedAt?: number;
	now?: number;
	requiresThread?: boolean;
}

const OPAQUE_CALLBACK_WIRE_BYTES = 36;

function utf8Bytes(value: string | undefined): number {
	return value ? new TextEncoder().encode(value).length : 0;
}

function nativeBlockLimitations(
	block: InteractionBlock,
	profile: ConnectorInteractionCapabilityProfile,
	context: InteractionNegotiationContext,
): string[] {
	const issues: string[] = [];
	const { limits } = profile;
	switch (block.kind) {
		case "choice": {
			const buttonIssues: string[] = [];
			if (limits.buttons.supported) {
				if (block.options.length > limits.buttons.maxPerMessage)
					buttonIssues.push("option count");
				if ((context.buttonsPerRow ?? 1) > limits.buttons.maxPerRow)
					buttonIssues.push("button row count");
				if (
					limits.buttons.maxCallbackBytes <
					(context.callbackBytes ?? OPAQUE_CALLBACK_WIRE_BYTES)
				)
					buttonIssues.push("opaque callback bytes");
				if (
					block.options.some(
						(option) => utf8Bytes(option.label) > limits.buttons.maxLabelBytes,
					)
				)
					buttonIssues.push("option label bytes");
			}
			const listIssues: string[] = [];
			if (limits.lists.supported) {
				if (block.options.length > limits.lists.maxItems)
					listIssues.push("option count");
				if (
					block.options.some(
						(option) => utf8Bytes(option.label) > limits.lists.maxLabelBytes,
					)
				)
					listIssues.push("option label bytes");
				if (
					block.options.some(
						(option) =>
							utf8Bytes(option.description) > limits.lists.maxDescriptionBytes,
					)
				)
					listIssues.push("option description bytes");
			}
			if (!limits.buttons.supported && !limits.lists.supported)
				issues.push("no native choice primitive");
			else if (
				(!limits.buttons.supported || buttonIssues.length > 0) &&
				(!limits.lists.supported || listIssues.length > 0)
			)
				issues.push(...buttonIssues, ...listIssues);
			break;
		}
		case "followups": {
			if (!limits.buttons.supported) issues.push("no native button primitive");
			if (block.options.length > limits.buttons.maxPerMessage)
				issues.push("option count");
			if ((context.buttonsPerRow ?? 1) > limits.buttons.maxPerRow)
				issues.push("button row count");
			if (
				limits.buttons.maxCallbackBytes <
				(context.callbackBytes ?? OPAQUE_CALLBACK_WIRE_BYTES)
			)
				issues.push("opaque callback bytes");
			if (
				block.options.some(
					(option) => utf8Bytes(option.label) > limits.buttons.maxLabelBytes,
				)
			)
				issues.push("option label bytes");
			break;
		}
		case "form": {
			if (!limits.forms.supported || !limits.modals.supported)
				issues.push("no native form/modal primitive");
			if (
				block.fields.length > limits.forms.maxFields ||
				block.fields.length > limits.modals.maxFields
			)
				issues.push("field count");
			if (utf8Bytes(block.title) > limits.modals.maxTitleBytes)
				issues.push("modal title bytes");
			const attachmentFields = block.fields.filter(
				(field) => field.type === "file" || field.type === "image",
			);
			if (attachmentFields.length > limits.attachments.maxCount)
				issues.push("attachment count");
			for (const field of block.fields) {
				if (field.type === "secret") issues.push("secret field");
				if ((field.options?.length ?? 0) > limits.forms.maxOptionsPerField)
					issues.push("field option count");
				if (field.type === "file" || field.type === "image") {
					if (!limits.attachments.supported)
						issues.push("attachments unsupported");
					if ((field.maxBytes ?? 0) > limits.attachments.maxBytesEach)
						issues.push("attachment bytes");
					if (
						field.mimeTypes?.some(
							(mime) =>
								!limits.attachments.mimeTypes.includes("*/*") &&
								!limits.attachments.mimeTypes.includes(mime),
						)
					)
						issues.push("attachment MIME type");
				}
			}
			break;
		}
		case "task": {
			if (!limits.links.supported && !limits.threads.supported)
				issues.push("no link or thread primitive");
			if (
				limits.links.supported &&
				!limits.threads.supported &&
				!context.signedHostedUrl
			)
				issues.push("task URL unavailable");
			if (
				limits.links.supported &&
				!limits.threads.supported &&
				context.signedHostedUrl &&
				utf8Bytes(context.signedHostedUrl) > limits.links.maxUrlBytes
			)
				issues.push("link URL bytes");
			if (
				limits.threads.supported &&
				utf8Bytes(block.title) > limits.threads.maxTitleBytes
			)
				issues.push("thread title bytes");
			break;
		}
		case "secret":
			issues.push("sensitive request required");
	}
	if (context.requiresThread && !limits.threads.supported)
		issues.push("threads unsupported");
	if (context.requiresEdit) {
		if (!limits.edits.supported) issues.push("edits unsupported");
		else if (
			limits.edits.windowMs !== null &&
			(context.sourceMessageCreatedAt === undefined ||
				context.now === undefined)
		)
			issues.push("edit window unknown");
		else if (
			limits.edits.windowMs !== null &&
			context.sourceMessageCreatedAt !== undefined &&
			context.now !== undefined &&
			context.now - context.sourceMessageCreatedAt > limits.edits.windowMs
		)
			issues.push("edit window expired");
	}
	const visible = JSON.stringify(block);
	if (utf8Bytes(visible) > limits.text.maxMessageBytes)
		issues.push("message bytes");
	return [...new Set(issues)].sort();
}

function signedHostedLimitations(
	profile: ConnectorInteractionCapabilityProfile,
	context: InteractionNegotiationContext,
): string[] {
	if (!profile.limits.links.supported) return ["links unsupported"];
	if (!context.signedHostedUrl) return ["signed hosted URL unavailable"];
	if (utf8Bytes(context.signedHostedUrl) > profile.limits.links.maxUrlBytes)
		return ["link URL bytes"];
	return [];
}

/** Select a layout solely from negotiated capability and present payload size. */
export function negotiateInteractionDelivery(
	block: InteractionBlock,
	profileValue: ConnectorInteractionCapabilityProfile,
	context: InteractionNegotiationContext = {},
): NegotiatedInteractionDelivery {
	const profile = normalizeConnectorInteractionCapabilityProfile(profileValue);
	if (block.kind === "secret") {
		return { mode: "sensitive-request", reason: "sensitive", limitations: [] };
	}
	if (
		block.kind === "form" &&
		block.fields.some((field) => field.type === "secret")
	) {
		throw new ElizaError(
			"Secret fields cannot use an ordinary interaction form.",
			{ code: "INTERACTION_SENSITIVE_FLOW_REQUIRED" },
		);
	}
	const modes = profile.blocks[block.kind].modes;
	const limitations = nativeBlockLimitations(block, profile, context);
	const fallbackLimitations = new Set(limitations);
	for (const mode of modes) {
		if (mode === "native") {
			if (limitations.length === 0) {
				return { mode, reason: "preferred", limitations };
			}
			continue;
		}
		if (mode === "signed-hosted") {
			const hostedIssues = signedHostedLimitations(profile, context);
			if (hostedIssues.length === 0) {
				return {
					mode,
					reason: modes.includes("native")
						? "native-limit"
						: "native-unavailable",
					limitations,
				};
			}
			for (const issue of hostedIssues) fallbackLimitations.add(issue);
			continue;
		}
		if (mode !== "sensitive-request") {
			return {
				mode,
				reason: modes.includes("native")
					? "native-limit"
					: "native-unavailable",
				limitations: [...fallbackLimitations].sort(),
			};
		}
	}
	throw new ElizaError("No safe interaction delivery mode was negotiated.", {
		code: "INTERACTION_DELIVERY_UNAVAILABLE",
		context: { kind: block.kind, profileId: profile.profileId },
	});
}

/** Rejects profile-ID collisions whose immutable account/target body differs. */
export class ConnectorInteractionProfileRegistry {
	private readonly profiles = new Map<
		string,
		{ fingerprint: string; profile: ConnectorInteractionCapabilityProfile }
	>();

	register(
		value: ConnectorInteractionCapabilityProfile,
	): ConnectorInteractionCapabilityProfile {
		const profile = normalizeConnectorInteractionCapabilityProfile(value);
		const fingerprint = stableStringify(profile);
		const existing = this.profiles.get(profile.profileId);
		if (existing && existing.fingerprint !== fingerprint) {
			throw new ElizaError(
				"Interaction profile ID collides with a different account or target profile.",
				{
					code: "INTERACTION_PROFILE_ID_COLLISION",
					context: { profileId: profile.profileId },
				},
			);
		}
		if (!existing)
			this.profiles.set(profile.profileId, { fingerprint, profile });
		return structuredClone(profile);
	}

	get(profileId: string): ConnectorInteractionCapabilityProfile | null {
		const entry = this.profiles.get(profileId);
		return entry ? structuredClone(entry.profile) : null;
	}
}

/** Deterministic reviewer-facing matrix; callers decide where to persist it. */
export function renderInteractionCapabilityMatrix(
	profiles: readonly ConnectorInteractionCapabilityProfile[],
): string {
	const rows = [...profiles]
		.map(normalizeConnectorInteractionCapabilityProfile)
		.sort((a, b) =>
			`${a.connector.source}\0${a.connector.accountId}\0${a.target.kind}\0${a.target.id}`.localeCompare(
				`${b.connector.source}\0${b.connector.accountId}\0${b.target.kind}\0${b.target.id}`,
			),
		)
		.map((profile) => {
			const modes = INTERACTION_BLOCK_KINDS.map(
				(kind) => `${kind}:${profile.blocks[kind].modes.join("→")}`,
			).join("<br>");
			return `| ${profile.connector.source} | ${profile.connector.accountId} | ${profile.target.kind}:${profile.target.id} | ${modes} | ${profile.limits.buttons.maxCallbackBytes} | ${profile.limits.attachments.supported ? `${profile.limits.attachments.maxCount} × ${profile.limits.attachments.maxBytesEach}` : "none"} |`;
		});
	return [
		"| Connector | Account | Target | Block delivery | Callback bytes | Attachments |",
		"| --- | --- | --- | --- | ---: | --- |",
		...rows,
	].join("\n");
}
