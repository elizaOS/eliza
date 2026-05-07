// action: SEND_MESSAGE
// route outbound messages through registered runtime message connectors

import { findEntityByName } from "../../../entities.ts";
import { requireActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { resolveCanonicalOwnerIdForMessage } from "../../../roles.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionResult,
	Content,
	HandlerOptions,
	IAgentRuntime,
	Media,
	Memory,
	MessageConnector,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	MessageTargetKind,
	State,
	TargetInfo,
	UUID,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { getActiveRoutingContextsForTurn } from "../../../utils/context-routing.ts";
import { stringToUuid } from "../../../utils.ts";

const spec = requireActionSpec("SEND_MESSAGE");

const ADMIN_TARGETS = new Set(["admin", "owner"]);
const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);
const AMBIGUITY_SCORE = 0.68;
const AMBIGUITY_DELTA = 0.12;

type SendMessageParams = {
	target?: unknown;
	source?: unknown;
	targetKind?: unknown;
	message?: unknown;
	thread?: unknown;
	attachments?: unknown;
	urgency?: unknown;

	// Compatibility with older SEND_MESSAGE / AGENT_SEND_MESSAGE params.
	text?: unknown;
	targetType?: unknown;
	recipient?: unknown;
	platform?: unknown;
};

type RuntimeWithLegacySendHandlers = IAgentRuntime & {
	sendHandlers?: Map<string, unknown>;
	getMessageConnectors?: () => MessageConnector[];
};

type SourceResolution = "exact" | "inferred" | "defaulted";

type NormalizedSendParams = {
	target?: string;
	source?: string;
	sourceResolution: SourceResolution;
	targetKind?: MessageTargetKind;
	message: string;
	thread?: string;
	attachments?: Media[];
	urgency: string;
};

type SendTargetCandidate = {
	connector: MessageConnector;
	target: TargetInfo;
	label: string;
	kind?: MessageTargetKind;
	description?: string;
	score: number;
	reasons: string[];
};

type TargetResolution =
	| {
			status: "resolved";
			candidate: SendTargetCandidate;
			sourceResolution: SourceResolution;
	  }
	| {
			status: "ambiguous";
			text: string;
			candidates: SendTargetCandidate[];
			sourceResolution: SourceResolution;
	  }
	| {
			status: "missing_connector" | "missing_target" | "unsupported";
			text: string;
			error: string;
			sourceResolution: SourceResolution;
	  };

const SEND_MESSAGE_PARAMETERS: ActionParameter[] = [
	{
		name: "target",
		description:
			"Recipient, contact name, handle, channel/room name, room ID, channel ID, or 'admin'/'owner'.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "source",
		description:
			"Connector source to send through, such as discord, telegram, signal, slack, email, sms, or client_chat.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "targetKind",
		description:
			"Target kind: user, contact, channel, room, thread, group, server, email, or phone.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "message",
		description: "Message text to send.",
		required: true,
		schema: { type: "string" },
	},
	{
		name: "thread",
		description:
			"Optional thread or parent-message identifier when replying in a thread.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "attachments",
		description:
			"Optional attachment list. Each item should include at least a url and may include id, title, source, description, or contentType.",
		required: false,
		schema: {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "string" },
					url: { type: "string" },
					title: { type: "string" },
					source: { type: "string" },
					description: { type: "string" },
					contentType: { type: "string" },
				},
			},
		},
	},
	{
		name: "urgency",
		description:
			"Optional urgency marker for downstream connector metadata: normal, important, or urgent.",
		required: false,
		schema: {
			type: "string",
			enum: ["normal", "important", "urgent"],
		},
	},
];

const BASE_DESCRIPTION =
	"Send a message through the runtime's registered message connectors. " +
	"Use uniform params: target, source, targetKind, message, thread, attachments, urgency. " +
	"Resolves exact source, inferred source, contacts/entities, channels/rooms, recent targets, and connector resolver hooks.";

const BASE_DESCRIPTION_COMPRESSED =
	"send message via registered connector params target source targetKind message thread attachments urgency resolve exact/infer source contact/entity channel/room recent target connector hooks";

function normalizeText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function normalizeComparable(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^[@#]+/, "")
		.replace(/\s+/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuidLike(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
		value,
	);
}

function stripTargetPrefix(value: string): string {
	return value
		.trim()
		.replace(/^[@#]+/, "")
		.trim();
}

function normalizeTargetKind(value: unknown): MessageTargetKind | undefined {
	const text = normalizeText(value);
	if (!text) return undefined;
	const normalized = text.toLowerCase();
	if (normalized === "room") return "room";
	if (normalized === "channel") return "channel";
	if (normalized === "thread") return "thread";
	if (normalized === "user") return "user";
	if (normalized === "recipient" || normalized === "person") return "contact";
	if (normalized === "contact") return "contact";
	if (normalized === "group") return "group";
	if (normalized === "server") return "server";
	if (normalized === "email") return "email";
	if (normalized === "phone" || normalized === "sms") return "phone";
	return normalized as MessageTargetKind;
}

function kindAliases(kind: MessageTargetKind): Set<string> {
	const normalized = String(kind).toLowerCase();
	if (normalized === "room") return new Set(["room", "channel", "group"]);
	if (normalized === "channel") return new Set(["channel", "room", "group"]);
	if (normalized === "user") return new Set(["user", "contact"]);
	if (normalized === "contact") return new Set(["contact", "user"]);
	if (normalized === "phone") return new Set(["phone", "sms", "contact"]);
	if (normalized === "email") return new Set(["email", "contact"]);
	return new Set([normalized]);
}

function kindsCompatible(
	requested: MessageTargetKind | undefined,
	actual: MessageTargetKind | undefined,
): boolean {
	if (!requested || !actual) return true;
	return kindAliases(requested).has(String(actual).toLowerCase());
}

function connectorSupportsKind(
	connector: MessageConnector,
	targetKind: MessageTargetKind | undefined,
): boolean {
	if (!targetKind || connector.supportedTargetKinds.length === 0) {
		return true;
	}
	const requestedAliases = kindAliases(targetKind);
	return connector.supportedTargetKinds.some((kind) =>
		requestedAliases.has(String(kind).toLowerCase()),
	);
}

function connectorAliases(connector: MessageConnector): string[] {
	const aliases = [connector.source, connector.label];
	const metadataAliases = connector.metadata?.aliases;
	if (Array.isArray(metadataAliases)) {
		for (const alias of metadataAliases) {
			if (typeof alias === "string") {
				aliases.push(alias);
			}
		}
	}
	return aliases.filter((alias) => alias.trim().length > 0);
}

function findConnectorBySource(
	connectors: MessageConnector[],
	source: string | undefined,
): MessageConnector | undefined {
	if (!source) return undefined;
	const normalized = normalizeComparable(source);
	return connectors.find((connector) =>
		connectorAliases(connector).some(
			(alias) => normalizeComparable(alias) === normalized,
		),
	);
}

function listMessageConnectors(runtime: IAgentRuntime): MessageConnector[] {
	const runtimeWithConnectors = runtime as RuntimeWithLegacySendHandlers;
	if (typeof runtimeWithConnectors.getMessageConnectors === "function") {
		return runtimeWithConnectors
			.getMessageConnectors()
			.filter((connector) =>
				connector.capabilities.length === 0
					? true
					: connector.capabilities.includes("send_message"),
			);
	}

	const sendHandlers = runtimeWithConnectors.sendHandlers;
	if (!(sendHandlers instanceof Map)) {
		return [];
	}

	return Array.from(sendHandlers.keys())
		.sort((a, b) => a.localeCompare(b))
		.map((source) => ({
			source,
			label: source
				.replace(/[_-]+/g, " ")
				.replace(/\b\w/g, (char) => char.toUpperCase()),
			capabilities: ["send_message"],
			supportedTargetKinds: [],
			contexts: [],
		}));
}

function connectorSummary(
	connector: MessageConnector,
	targetPreviews: string[] = [],
): string {
	const kinds =
		connector.supportedTargetKinds.length > 0
			? connector.supportedTargetKinds.join("|")
			: "any";
	const contexts =
		connector.contexts.length > 0 ? connector.contexts.join("|") : "any";
	const caps =
		connector.capabilities.length > 0
			? connector.capabilities.join("|")
			: "send_message";
	const targets =
		targetPreviews.length > 0 ? `,targets:${targetPreviews.join("|")}` : "";
	return `${connector.source}{label:${connector.label},kinds:${kinds},contexts:${contexts},capabilities:${caps}${targets}}`;
}

function buildDynamicDescription(
	connectors: MessageConnector[],
	targetPreviews = new Map<string, string[]>(),
): {
	description: string;
	descriptionCompressed: string;
} {
	if (connectors.length === 0) {
		return {
			description: `${BASE_DESCRIPTION}\nconnectors[0]: none_registered`,
			descriptionCompressed: `${BASE_DESCRIPTION_COMPRESSED} connectors[0]: none_registered`,
		};
	}

	const visible = connectors
		.slice(0, 8)
		.map((connector) =>
			connectorSummary(connector, targetPreviews.get(connector.source) ?? []),
		);
	const suffix =
		connectors.length > visible.length
			? `; +${connectors.length - visible.length} more`
			: "";
	const connectorText = `connectors[${connectors.length}]: ${visible.join("; ")}${suffix}`;
	return {
		description: `${BASE_DESCRIPTION}\n${connectorText}`,
		descriptionCompressed: `${BASE_DESCRIPTION_COMPRESSED} ${connectorText}`,
	};
}

async function previewConnectorTargets(
	connector: MessageConnector,
	context: MessageConnectorQueryContext,
): Promise<string[]> {
	const previews: string[] = [];
	const addPreview = (target: MessageConnectorTarget) => {
		const label = target.label ?? targetLabel(target.target);
		if (!label || previews.includes(label)) return;
		previews.push(target.kind ? `${target.kind}:${label}` : label);
	};

	if (connector.listRecentTargets) {
		try {
			for (const target of await connector.listRecentTargets(context)) {
				addPreview(target);
				if (previews.length >= 3) return previews;
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] listRecentTargets preview failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (connector.listRooms) {
		try {
			for (const target of await connector.listRooms(context)) {
				addPreview(target);
				if (previews.length >= 3) return previews;
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] listRooms preview failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return previews;
}

async function refreshActionDescription(
	runtime: IAgentRuntime,
	message?: Memory,
	state?: State,
): Promise<void> {
	const connectors = listMessageConnectors(runtime);
	const targetPreviews = new Map<string, string[]>();
	if (message) {
		await Promise.all(
			connectors.slice(0, 8).map(async (connector) => {
				if (!connector.listRecentTargets && !connector.listRooms) {
					return;
				}
				const context = buildQueryContext(
					runtime,
					message,
					state,
					connector.source,
					undefined,
				);
				const previews = await previewConnectorTargets(connector, context);
				if (previews.length > 0) {
					targetPreviews.set(connector.source, previews);
				}
			}),
		);
	}

	const dynamic = buildDynamicDescription(connectors, targetPreviews);
	sendMessageAction.description = dynamic.description;
	sendMessageAction.descriptionCompressed = dynamic.descriptionCompressed;
}

function inferSourceFromTarget(
	target: string | undefined,
	connectors: MessageConnector[],
): { target?: string; source?: string } {
	if (!target) return {};

	const prefixMatch = target.match(
		/^([a-z0-9_-][a-z0-9 _-]{1,40})\s*[:/]\s*(.+)$/i,
	);
	if (prefixMatch?.[1] && prefixMatch[2]) {
		const connector = findConnectorBySource(connectors, prefixMatch[1]);
		if (connector) {
			return { source: connector.source, target: prefixMatch[2].trim() };
		}
	}

	const onMatch = target.match(
		/^(.+?)\s+(?:on|via|through)\s+([a-z0-9 _-]{2,40})$/i,
	);
	if (onMatch?.[1] && onMatch[2]) {
		const connector = findConnectorBySource(connectors, onMatch[2]);
		if (connector) {
			return { source: connector.source, target: onMatch[1].trim() };
		}
	}

	return { target };
}

function inferSourceFromText(
	text: string | undefined,
	connectors: MessageConnector[],
): string | undefined {
	if (!text) return undefined;
	for (const connector of connectors) {
		for (const alias of connectorAliases(connector)) {
			const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(
				`\\b(?:on|via|through|using)\\s+${escaped}\\b`,
				"i",
			);
			if (pattern.test(text)) {
				return connector.source;
			}
		}
	}
	return undefined;
}

function inferTargetFromText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const patterns = [
		/(?:send|message|dm|tell)\s+(?:a\s+message\s+to\s+|to\s+)?(["'][^"']+["']|[@#][\w.-]+)/i,
		/(?:post|drop|send)\s+(?:this\s+)?(?:in|to)\s+(["'][^"']+["']|#[\w.-]+)/i,
		/(?:to|for)\s+(["'][^"']+["']|[@#][\w.-]+)/i,
	];
	for (const pattern of patterns) {
		const match = text.match(pattern);
		const raw = match?.[1]?.trim();
		if (raw) {
			return raw.replace(/^["']|["']$/g, "").trim();
		}
	}
	return undefined;
}

function recentTextFromState(state: State | undefined): string {
	const values = state?.values ?? {};
	const chunks = [
		values.recentMessage,
		values.recentMessages,
		values.recentInteractions,
		values.recentMessageInteractions,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
	return chunks.slice(-4000);
}

function inferTargetFromRecentConversation(
	state: State | undefined,
): string | undefined {
	const recentText = recentTextFromState(state);
	if (!recentText) return undefined;
	const matches = Array.from(recentText.matchAll(/[@#][\w.-]{2,}/g));
	const last = matches.at(-1)?.[0];
	return last?.trim();
}

function normalizeAttachments(value: unknown): Media[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attachments: Media[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const url = normalizeText(item.url);
		if (!url) continue;
		attachments.push({
			...item,
			id: normalizeText(item.id) ?? url,
			url,
		} as Media);
	}
	return attachments.length > 0 ? attachments : undefined;
}

function normalizeParams(
	raw: SendMessageParams,
	message: Memory,
	state: State | undefined,
	connectors: MessageConnector[],
): NormalizedSendParams {
	let target =
		normalizeText(raw.target) ??
		normalizeText(raw.recipient) ??
		normalizeText(message.content.target) ??
		inferTargetFromText(message.content.text) ??
		inferTargetFromRecentConversation(state);
	let source = normalizeText(raw.source) ?? normalizeText(raw.platform);
	let sourceResolution: SourceResolution = source ? "exact" : "inferred";

	const targetSource = inferSourceFromTarget(target, connectors);
	if (!source && targetSource.source) {
		source = targetSource.source;
		sourceResolution = "inferred";
	}
	if (targetSource.target) {
		target = targetSource.target;
	}

	if (!source) {
		source = inferSourceFromText(message.content.text, connectors);
		if (source) {
			sourceResolution = "inferred";
		}
	}

	const text = normalizeText(raw.message) ?? normalizeText(raw.text) ?? "";
	const targetKind = normalizeTargetKind(raw.targetKind ?? raw.targetType);
	const thread = normalizeText(raw.thread);
	const urgency = normalizeText(raw.urgency) ?? "normal";

	return {
		target,
		source,
		sourceResolution,
		targetKind,
		message: text,
		thread,
		attachments: normalizeAttachments(raw.attachments),
		urgency,
	};
}

function buildQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	source: string | undefined,
	target?: TargetInfo,
): MessageConnectorQueryContext {
	return {
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		target,
		contexts: getActiveRoutingContextsForTurn(state, message),
		metadata: {
			recentText: recentTextFromState(state),
			messageText: message.content.text,
		},
	};
}

function targetLabel(target: TargetInfo): string {
	return (
		target.channelId ??
		target.roomId ??
		target.entityId ??
		target.threadId ??
		target.serverId ??
		target.source
	);
}

function candidateText(candidate: MessageConnectorTarget): string {
	const pieces = [
		candidate.label,
		candidate.description,
		candidate.target.channelId,
		candidate.target.roomId,
		candidate.target.entityId,
		candidate.target.threadId,
		candidate.target.serverId,
	];
	if (candidate.metadata) {
		for (const value of Object.values(candidate.metadata)) {
			if (typeof value === "string") {
				pieces.push(value);
			}
		}
	}
	return pieces.filter(Boolean).join(" ");
}

function queryMatchesCandidate(
	query: string | undefined,
	candidate: MessageConnectorTarget,
): boolean {
	if (!query) return true;
	const normalizedQuery = normalizeComparable(query);
	const withoutPrefix = normalizeComparable(stripTargetPrefix(query));
	const haystack = normalizeComparable(candidateText(candidate));
	return (
		haystack.includes(normalizedQuery) ||
		haystack.includes(withoutPrefix) ||
		normalizeComparable(candidate.label) === withoutPrefix
	);
}

function scoreHookCandidate(
	raw: MessageConnectorTarget,
	query: string | undefined,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	baseScore: number,
	reasons: string[],
): number {
	let score =
		typeof raw.score === "number" && Number.isFinite(raw.score)
			? raw.score
			: baseScore;

	if (query && queryMatchesCandidate(query, raw)) {
		score += 0.12;
	}
	if (targetKind && kindsCompatible(targetKind, raw.kind)) {
		score += 0.08;
	}
	if (sourceWasExact) {
		score += 0.08;
	}
	if (reasons.includes("resolveTargets")) {
		score += 0.08;
	}

	return Math.max(0, Math.min(1, score));
}

function normalizeHookCandidate(
	connector: MessageConnector,
	raw: MessageConnectorTarget,
	query: string | undefined,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	baseScore: number,
	reasons: string[],
): SendTargetCandidate | null {
	if (!kindsCompatible(targetKind, raw.kind)) {
		return null;
	}
	if (!queryMatchesCandidate(query, raw)) {
		return null;
	}

	const target = {
		...raw.target,
		source: raw.target.source || connector.source,
	} as TargetInfo;

	return {
		connector,
		target,
		label: raw.label ?? targetLabel(target),
		kind: raw.kind ?? targetKind,
		description: raw.description,
		score: scoreHookCandidate(
			raw,
			query,
			targetKind,
			sourceWasExact,
			baseScore,
			reasons,
		),
		reasons,
	};
}

async function collectHookTargets(
	connector: MessageConnector,
	query: string | undefined,
	context: MessageConnectorQueryContext,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): Promise<SendTargetCandidate[]> {
	const candidates: SendTargetCandidate[] = [];

	if (query && connector.resolveTargets) {
		try {
			const resolved = await connector.resolveTargets(query, context);
			for (const raw of resolved) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					0.74,
					["resolveTargets"],
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (connector.listRecentTargets) {
		try {
			const recentTargets = await connector.listRecentTargets(context);
			for (const raw of recentTargets) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					query ? 0.52 : 0.62,
					["listRecentTargets"],
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] listRecentTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (
		connector.listRooms &&
		(query ||
			!targetKind ||
			kindAliases(targetKind).has("room") ||
			kindAliases(targetKind).has("channel"))
	) {
		try {
			const rooms = await connector.listRooms(context);
			for (const raw of rooms) {
				const candidate = normalizeHookCandidate(
					connector,
					raw,
					query,
					targetKind,
					sourceWasExact,
					0.56,
					["listRooms"],
				);
				if (candidate) candidates.push(candidate);
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] listRooms failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return candidates;
}

function explicitTargetFromString(
	connector: MessageConnector,
	rawTarget: string,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): SendTargetCandidate {
	let kind = targetKind;
	let targetValue = rawTarget.trim();
	const fieldMatch = targetValue.match(
		/^(room|channel|server|entity|user|contact|thread|group|email|phone):(.+)$/i,
	);
	if (fieldMatch?.[1] && fieldMatch[2]) {
		kind = normalizeTargetKind(fieldMatch[1]);
		targetValue = fieldMatch[2].trim();
	}

	const target = { source: connector.source } as TargetInfo;
	const stripped = stripTargetPrefix(targetValue);

	if (kind === "room") {
		if (isUuidLike(targetValue)) {
			target.roomId = targetValue as UUID;
		} else {
			target.channelId = stripped;
		}
	} else if (kind === "channel" || kind === "group") {
		target.channelId = stripped;
	} else if (kind === "server") {
		target.serverId = targetValue;
	} else if (kind === "thread") {
		target.threadId = targetValue;
	} else if (kind === "phone" || kind === "email") {
		target.entityId = targetValue as UUID;
		target.channelId = targetValue;
	} else if (kind === "user" || kind === "contact") {
		target.entityId = stripped as UUID;
	} else if (targetValue.startsWith("#")) {
		kind = "channel";
		target.channelId = stripped;
	} else if (targetValue.startsWith("@")) {
		kind = "user";
		target.entityId = stripped as UUID;
	} else if (isUuidLike(targetValue)) {
		kind = "room";
		target.roomId = targetValue as UUID;
	} else {
		kind = "channel";
		target.channelId = stripped;
	}

	return {
		connector,
		target,
		label: targetValue,
		kind,
		score: sourceWasExact ? 0.64 : 0.52,
		reasons: ["explicitTarget"],
	};
}

function componentString(
	component: { data?: Record<string, unknown> },
	keys: string[],
): string | undefined {
	for (const key of keys) {
		const value = component.data?.[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
		if (typeof value === "number") {
			return String(value);
		}
	}
	return undefined;
}

async function collectEntityCandidates(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	query: string | undefined,
	connectors: MessageConnector[],
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): Promise<SendTargetCandidate[]> {
	if (
		!query ||
		(targetKind &&
			!kindAliases(targetKind).has("user") &&
			!kindAliases(targetKind).has("contact") &&
			!kindAliases(targetKind).has("email") &&
			!kindAliases(targetKind).has("phone"))
	) {
		return [];
	}

	try {
		const entity = await findEntityByName(
			runtime,
			{
				...message,
				content: {
					...message.content,
					text: query,
				},
			},
			state ?? ({ values: {}, data: {}, text: "" } as State),
		);
		if (!entity?.id) {
			return [];
		}

		const label = entity.names?.[0] ?? query;
		const candidates: SendTargetCandidate[] = [];
		for (const connector of connectors) {
			if (!connectorSupportsKind(connector, targetKind ?? "contact")) {
				continue;
			}
			const matchingComponent = entity.components?.find(
				(component) =>
					normalizeComparable(component.type) ===
					normalizeComparable(connector.source),
			);
			const target = {
				source: connector.source,
				entityId: entity.id as UUID,
			} as TargetInfo;

			if (matchingComponent) {
				const channelId = componentString(matchingComponent, [
					"channelId",
					"chatId",
					"conversationId",
					"phone",
					"phoneNumber",
					"email",
				]);
				if (channelId) {
					target.channelId = channelId;
				}
				const roomId = componentString(matchingComponent, ["roomId"]);
				if (roomId) {
					target.roomId = roomId as UUID;
				}
				const serverId = componentString(matchingComponent, ["serverId"]);
				if (serverId) {
					target.serverId = serverId;
				}
			}

			candidates.push({
				connector,
				target,
				label,
				kind: targetKind ?? "contact",
				score: matchingComponent ? 0.78 : sourceWasExact ? 0.66 : 0.56,
				reasons: matchingComponent ? ["entity", "component"] : ["entity"],
			});
		}
		return candidates;
	} catch (error) {
		logger.warn(
			`[SEND_MESSAGE] entity resolution failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

async function currentRoomCandidate(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	connector: MessageConnector,
	sourceWasExact: boolean,
): Promise<SendTargetCandidate> {
	const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
	const target = {
		source: connector.source,
		roomId: (room?.id ?? message.roomId) as UUID,
	} as TargetInfo;
	if (room?.channelId) {
		target.channelId = room.channelId;
	}
	if (room?.serverId) {
		target.serverId = room.serverId;
	}

	const roomSource =
		typeof room?.source === "string" ? room.source : message.content.source;
	const sourceMatches =
		normalizeComparable(roomSource) === normalizeComparable(connector.source);

	return {
		connector,
		target,
		label: room?.name ?? targetLabel(target),
		kind: "room",
		score: sourceWasExact || sourceMatches ? 0.72 : 0.54,
		reasons: ["currentRoom"],
	};
}

function dedupeCandidates(
	candidates: SendTargetCandidate[],
): SendTargetCandidate[] {
	const byKey = new Map<string, SendTargetCandidate>();
	for (const candidate of candidates) {
		const key = [
			candidate.connector.source,
			candidate.target.roomId,
			candidate.target.channelId,
			candidate.target.serverId,
			candidate.target.entityId,
			candidate.target.threadId,
		].join("|");
		const existing = byKey.get(key);
		if (!existing || candidate.score > existing.score) {
			byKey.set(key, candidate);
		}
	}
	return Array.from(byKey.values()).sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		return left.label.localeCompare(right.label);
	});
}

function formatCandidates(candidates: SendTargetCandidate[]): string {
	return candidates
		.slice(0, 6)
		.map((candidate, index) => {
			const kind = candidate.kind ? ` kind=${candidate.kind}` : "";
			const score = ` score=${candidate.score.toFixed(2)}`;
			return `${index + 1}. ${candidate.label} source=${candidate.connector.source}${kind}${score} target=${JSON.stringify(candidate.target)}`;
		})
		.join("\n");
}

async function resolveAdminTarget(
	runtime: IAgentRuntime,
	message: Memory,
	connectors: MessageConnector[],
	params: NormalizedSendParams,
): Promise<SendTargetCandidate | null> {
	if (!params.target || !ADMIN_TARGETS.has(params.target.toLowerCase())) {
		return null;
	}

	const source = params.source ?? "client_chat";
	const connector = findConnectorBySource(connectors, source);
	if (!connector) {
		return null;
	}

	const ownerId =
		(await resolveCanonicalOwnerIdForMessage(runtime, message)) ??
		stringToUuid(`${runtime.character?.name ?? runtime.agentId}-admin-entity`);

	return {
		connector,
		target: {
			source: connector.source,
			entityId: ownerId as UUID,
		} as TargetInfo,
		label: params.target,
		kind: "contact",
		score: 1,
		reasons: ["admin"],
	};
}

async function resolveSendTarget(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	connectors: MessageConnector[],
	params: NormalizedSendParams,
): Promise<TargetResolution> {
	if (connectors.length === 0) {
		return {
			status: "missing_connector",
			text: "No message connectors are registered. Connect or enable a messaging connector before using SEND_MESSAGE.",
			error: "NO_CONNECTORS_REGISTERED",
			sourceResolution: params.sourceResolution,
		};
	}

	const exactConnector = findConnectorBySource(connectors, params.source);
	if (params.source && !exactConnector) {
		return {
			status: "missing_connector",
			text: `No message connector is registered for source "${params.source}". Available sources: ${connectors.map((connector) => connector.source).join(", ")}.`,
			error: "SOURCE_CONNECTOR_NOT_FOUND",
			sourceResolution: "exact",
		};
	}

	const candidates: SendTargetCandidate[] = [];
	const adminCandidate = await resolveAdminTarget(
		runtime,
		message,
		connectors,
		params,
	);
	if (adminCandidate) {
		return {
			status: "resolved",
			candidate: adminCandidate,
			sourceResolution: params.source ? params.sourceResolution : "defaulted",
		};
	}

	const sourceWasExact = Boolean(params.source && exactConnector);
	let consideredConnectors = exactConnector
		? [exactConnector]
		: connectors.filter((connector) =>
				connectorSupportsKind(connector, params.targetKind),
			);

	if (consideredConnectors.length === 0) {
		return {
			status: "unsupported",
			text: `No registered message connector supports targetKind "${params.targetKind}". Available connector target kinds: ${connectors.map((connector) => connectorSummary(connector)).join("; ")}.`,
			error: "TARGET_KIND_UNSUPPORTED",
			sourceResolution: params.sourceResolution,
		};
	}

	if (!params.target && !params.source) {
		const currentSource = normalizeText(message.content.source);
		const currentConnector = findConnectorBySource(
			consideredConnectors,
			currentSource,
		);
		if (currentConnector) {
			consideredConnectors = [currentConnector];
		}
	}

	const context = buildQueryContext(
		runtime,
		message,
		state,
		params.source,
		undefined,
	);

	for (const connector of consideredConnectors) {
		candidates.push(
			...(await collectHookTargets(
				connector,
				params.target,
				context,
				params.targetKind,
				sourceWasExact,
			)),
		);
	}

	candidates.push(
		...(await collectEntityCandidates(
			runtime,
			message,
			state,
			params.target,
			consideredConnectors,
			params.targetKind,
			sourceWasExact,
		)),
	);

	if (params.target) {
		for (const connector of consideredConnectors) {
			candidates.push(
				explicitTargetFromString(
					connector,
					params.target,
					params.targetKind,
					sourceWasExact,
				),
			);
		}
	} else if (consideredConnectors.length === 1) {
		candidates.push(
			await currentRoomCandidate(
				runtime,
				message,
				state,
				consideredConnectors[0],
				sourceWasExact,
			),
		);
	}

	const sorted = dedupeCandidates(candidates);
	if (sorted.length === 0) {
		return {
			status: "missing_target",
			text: "SEND_MESSAGE could not resolve a target. Provide target and, if needed, source/targetKind.",
			error: "TARGET_NOT_RESOLVED",
			sourceResolution: params.sourceResolution,
		};
	}

	const top = sorted[0];
	const ambiguous = sorted.filter(
		(candidate) =>
			candidate !== top &&
			Math.abs(top.score - candidate.score) <= AMBIGUITY_DELTA,
	);
	if (
		ambiguous.length > 0 &&
		(!params.source || top.score >= AMBIGUITY_SCORE)
	) {
		const choices = [top, ...ambiguous];
		return {
			status: "ambiguous",
			text:
				"SEND_MESSAGE found multiple plausible targets. Specify a more exact target/source, or choose one of these options:\n" +
				formatCandidates(choices),
			candidates: choices,
			sourceResolution: params.source ? "exact" : "inferred",
		};
	}

	if (top.score < 0.5 && consideredConnectors.length > 1) {
		return {
			status: "ambiguous",
			text:
				"SEND_MESSAGE needs a source or more specific target. Registered connector options:\n" +
				connectors
					.map(
						(connector, index) =>
							`${index + 1}. ${connectorSummary(connector)}`,
					)
					.join("\n"),
			candidates: sorted,
			sourceResolution: params.sourceResolution,
		};
	}

	return {
		status: "resolved",
		candidate: top,
		sourceResolution:
			params.sourceResolution === "exact"
				? "exact"
				: params.source
					? "inferred"
					: consideredConnectors.length === 1
						? "defaulted"
						: "inferred",
	};
}

async function selectedContextData(
	connector: MessageConnector,
	target: TargetInfo,
	context: MessageConnectorQueryContext,
): Promise<Record<string, unknown>> {
	const data: Record<string, unknown> = {};
	if (connector.getChatContext) {
		try {
			const chatContext = await connector.getChatContext(target, context);
			if (chatContext) {
				data.chatContext = chatContext;
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] getChatContext failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	if (target.entityId && connector.getUserContext) {
		try {
			const userContext = await connector.getUserContext(
				target.entityId,
				context,
			);
			if (userContext) {
				data.userContext = userContext;
			}
		} catch (error) {
			logger.warn(
				`[SEND_MESSAGE] getUserContext failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return data;
}

function buildContent(params: NormalizedSendParams): Content {
	const content: Content = {
		text: params.message,
		source: params.source,
		metadata: {
			urgency: params.urgency,
			targetKind: params.targetKind,
		},
	};
	if (params.attachments) {
		content.attachments = params.attachments;
	}
	return content;
}

function withThread(
	target: TargetInfo,
	thread: string | undefined,
): TargetInfo {
	if (!thread) return target;
	return {
		...target,
		threadId: thread,
	};
}

function invalidResult(text: string, error: string): ActionResult {
	return {
		text,
		success: false,
		values: { success: false, error },
		data: { actionName: "SEND_MESSAGE", error },
	};
}

/**
 * Represents an action to send a message through registered message connectors.
 */
export const sendMessageAction: Action = {
	name: "SEND_MESSAGE",
	similes: spec.similes ? [...spec.similes] : ["DM", "MESSAGE", "SEND_DM"],
	description: BASE_DESCRIPTION,
	descriptionCompressed: BASE_DESCRIPTION_COMPRESSED,
	contexts: ["messaging", "email", "contacts", "connectors", "social_posting"],
	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => {
		await refreshActionDescription(runtime, message, state);
		return hasActionContextOrKeyword(message, state, {
			contexts: [
				"messaging",
				"email",
				"contacts",
				"connectors",
				"social_posting",
			],
			keywords: [
				"send message",
				"dm",
				"direct message",
				"email",
				"tell",
				"notify",
				"message them",
				"post to",
				"post in",
			],
		});
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<ActionResult> => {
		await refreshActionDescription(runtime, message, state);

		const rawParams = ((options as HandlerOptions | undefined)?.parameters ??
			{}) as SendMessageParams;
		const connectors = listMessageConnectors(runtime);
		const params = normalizeParams(rawParams, message, state, connectors);

		if (!params.message && !params.attachments) {
			return invalidResult(
				"SEND_MESSAGE requires a non-empty message or attachments.",
				"INVALID_PARAMETERS",
			);
		}

		if (!VALID_URGENCIES.has(params.urgency)) {
			return invalidResult(
				`SEND_MESSAGE urgency must be one of: normal, important, urgent. Got "${params.urgency}".`,
				"INVALID_PARAMETERS",
			);
		}

		const resolution = await resolveSendTarget(
			runtime,
			message,
			state,
			connectors,
			params,
		);

		if (resolution.status !== "resolved") {
			const errorCode =
				resolution.status === "ambiguous"
					? "TARGET_AMBIGUOUS"
					: resolution.error;
			return {
				text: resolution.text,
				success: false,
				values: {
					success: false,
					error: errorCode,
				},
				data: {
					actionName: "SEND_MESSAGE",
					error: errorCode,
					sourceResolution: resolution.sourceResolution,
					candidates:
						"candidates" in resolution
							? resolution.candidates.map((candidate) => ({
									source: candidate.connector.source,
									label: candidate.label,
									kind: candidate.kind,
									score: candidate.score,
									target: candidate.target,
								}))
							: undefined,
				},
			};
		}

		const selected = resolution.candidate;
		const target = withThread(selected.target, params.thread);
		const content = buildContent({
			...params,
			source: selected.connector.source,
		});
		const context = buildQueryContext(
			runtime,
			message,
			state,
			selected.connector.source,
			target,
		);
		const extraContext = await selectedContextData(
			selected.connector,
			target,
			context,
		);

		try {
			await runtime.sendMessageToTarget(target, content);
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			logger.error(
				`[SEND_MESSAGE] Failed to send via ${selected.connector.source}: ${errMsg}`,
			);
			return {
				text: `Failed to send message via ${selected.connector.label}: ${errMsg}`,
				success: false,
				values: {
					success: false,
					error: "SEND_FAILED",
					source: selected.connector.source,
				},
				data: {
					actionName: "SEND_MESSAGE",
					error: "SEND_FAILED",
					source: selected.connector.source,
					target,
					targetKind: selected.kind,
					sourceResolution: resolution.sourceResolution,
				},
			};
		}

		return {
			text: `Message sent via ${selected.connector.label} to ${selected.label}.`,
			success: true,
			values: {
				success: true,
				source: selected.connector.source,
				target: selected.label,
				targetKind: selected.kind,
				sourceResolution: resolution.sourceResolution,
			},
			data: {
				actionName: "SEND_MESSAGE",
				source: selected.connector.source,
				target,
				targetLabel: selected.label,
				targetKind: selected.kind,
				sourceResolution: resolution.sourceResolution,
				resolutionReasons: selected.reasons,
				thread: params.thread,
				urgency: params.urgency,
				...extraContext,
			},
		};
	},
	parameters: SEND_MESSAGE_PARAMETERS,
	examples: (spec.examples ?? []) as ActionExample[][],
};

export default sendMessageAction;
