// MESSAGE — single polymorphic action surface for the messaging domain.
//
// Dispatches to a switch over MESSAGE_OPS. Connector-backed ops (read_channel,
// search, list_channels, list_servers, react, edit, delete, pin, join, leave,
// get_user) call MessageConnector hooks directly. read_with_contact resolves a
// person via the relationships graph and views their conversations across
// every connected platform. Triage / inbox / draft ops delegate to the
// existing triage actions in features/messaging/triage.
//
// Former leaf message actions are gone — MESSAGE is the only registration.

import { findEntityByName } from "../../../entities.ts";
import { getActionSpec } from "../../../generated/spec-helpers.ts";
import { logger } from "../../../logger.ts";
import { resolveCanonicalOwnerIdForMessage } from "../../../roles.ts";
import { runWithActionRoutingContext } from "../../../runtime/action-routing-context.ts";
import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionResult,
	Content,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Media,
	Memory,
	MessageConnector,
	MessageConnectorQueryContext,
	MessageConnectorTarget,
	MessageTargetKind,
	Room,
	SearchCategoryRegistration,
	State,
	TargetInfo,
	UUID,
} from "../../../types/index.ts";
import { ChannelType, ModelType } from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import { getActiveRoutingContextsForTurn } from "../../../utils/context-routing.ts";
import { stringToUuid } from "../../../utils.ts";
import { draftFollowupAction } from "../../messaging/triage/actions/draftFollowup.ts";
import { draftReplyAction } from "../../messaging/triage/actions/draftReply.ts";
import { listInboxAction } from "../../messaging/triage/actions/listInbox.ts";
import { manageMessageAction } from "../../messaging/triage/actions/manageMessage.ts";
import { respondToMessageAction } from "../../messaging/triage/actions/respondToMessage.ts";
import { scheduleDraftSendAction } from "../../messaging/triage/actions/scheduleDraftSend.ts";
import { searchMessagesAction as searchInboxMessagesAction } from "../../messaging/triage/actions/searchMessages.ts";
import { sendDraftAction } from "../../messaging/triage/actions/sendDraft.ts";
import { triageMessagesAction } from "../../messaging/triage/actions/triageMessages.ts";
import { refreshMessageConnectorActionDescription } from "./connectorActionUtils.ts";

// ---------------------------------------------------------------------------
// Op taxonomy
// ---------------------------------------------------------------------------

export const MESSAGE_OPS = [
	"send",
	"read_channel",
	"read_with_contact",
	"search",
	"list_channels",
	"list_servers",
	"join",
	"leave",
	"react",
	"edit",
	"delete",
	"pin",
	"get_user",
	// Inbox / triage / draft ops (delegated to triage actions)
	"triage",
	"list_inbox",
	"search_inbox",
	"draft_reply",
	"draft_followup",
	"respond",
	"send_draft",
	"schedule_draft_send",
	"manage",
] as const;

export type MessageOperation = (typeof MESSAGE_OPS)[number];

const MESSAGE_CONTEXTS = ["messaging", "email", "contacts", "connectors"];

const MESSAGE_DESCRIPTION =
	"Primary action for addressed messaging surfaces: DMs, group chats, channels, rooms, threads, servers, users, inboxes, drafts, and owner message workflows. Use action to choose the operation. Public feed publishing belongs to POST.";
const MESSAGE_COMPRESSED =
	"primary message action send read_channel read_with_contact search list_channels list_servers join leave react edit delete pin get_user triage list_inbox search_inbox draft_reply draft_followup respond send_draft schedule_draft_send manage dm group channel room thread user server inbox draft";

// ---------------------------------------------------------------------------
// Param coercion / op normalization
// ---------------------------------------------------------------------------

type ParamRecord = Record<string, unknown>;

function paramsFromOptions(options: HandlerOptions | undefined): ParamRecord {
	return (options?.parameters ?? {}) as ParamRecord;
}

function textParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function boolParam(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	if (["true", "yes", "1", "on"].includes(normalized)) return true;
	if (["false", "no", "0", "off"].includes(normalized)) return false;
	return undefined;
}

function numberParam(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function clampLimit(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	const base = value ?? fallback;
	return Math.max(1, Math.min(max, Math.floor(base)));
}

function normalizeComparable(value: unknown): string {
	return String(value ?? "")
		.trim()
		.toLowerCase()
		.replace(/^[@#]+/, "")
		.replace(/\s+/g, " ");
}

function isUuidLike(value: string | undefined): value is UUID {
	return Boolean(
		value &&
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
				value,
			),
	);
}

function stripTargetPrefix(value: string): string {
	return value
		.trim()
		.replace(/^[@#]+/, "")
		.trim();
}

const OP_ALIASES: Record<string, MessageOperation> = {
	send_message: "send",
	dm: "send",
	read_messages: "read_channel",
	read: "read_channel",
	read_room: "read_channel",
	read_chat: "read_channel",
	read_with_contact: "read_with_contact",
	read_dms: "read_with_contact",
	conversation_with: "read_with_contact",
	chat_with: "read_with_contact",
	find: "search",
	search_messages: "search",
	search_chats: "search",
	search_conversations: "search",
	cross_channel_search: "search",
	list_rooms: "list_channels",
	list_chats: "list_channels",
	list_workspaces: "list_servers",
	list_guilds: "list_servers",
	react_to_message: "react",
	reaction: "react",
	edit_message: "edit",
	update_message: "edit",
	delete_message: "delete",
	remove_message: "delete",
	pin_message: "pin",
	unpin: "pin",
	join_channel: "join",
	join_room: "join",
	leave_channel: "leave",
	leave_room: "leave",
	get_user_info: "get_user",
	lookup_user: "get_user",
	triage_messages: "triage",
	triage_inbox: "triage",
	prioritize_messages: "triage",
	rank_inbox: "triage",
	scan_messages: "triage",
	list_messages: "list_inbox",
	show_unread_across: "list_inbox",
	search_inbox: "search_inbox",
	search_email: "search_inbox",
	compose_reply: "draft_reply",
	draft_message_reply: "draft_reply",
	compose_followup: "draft_followup",
	followup_draft: "draft_followup",
	check_in_draft: "draft_followup",
	dispatch_draft: "send_draft",
	confirm_and_send: "send_draft",
	compose_message: "send_draft",
	outbound_message: "send_draft",
	schedule_send: "schedule_draft_send",
	defer_send: "schedule_draft_send",
	send_later: "schedule_draft_send",
	respond_to_message: "respond",
	reply_to_message: "respond",
	quick_reply: "respond",
	one_shot_reply: "respond",
	manage_message: "manage",
	archive_message: "manage",
	tag_message: "manage",
	unsubscribe: "manage",
	block_sender: "manage",
	mark_read: "manage",
};

function normalizeOp(value: unknown): MessageOperation | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, "_");
	if ((MESSAGE_OPS as readonly string[]).includes(normalized)) {
		return normalized as MessageOperation;
	}
	return OP_ALIASES[normalized];
}

function inferOp(message: Memory, params: ParamRecord): MessageOperation {
	const explicit = normalizeOp(params.action);
	if (explicit) return explicit;

	const text = `${message.content?.text ?? ""}`.toLowerCase();

	if (params.draftId && params.sendAt) return "schedule_draft_send";
	if (params.draftId) return "send_draft";
	if (
		params.manageOperation ||
		/\b(unsubscribe|archive|trash|spam|mark read|label)\b/.test(text)
	) {
		return "manage";
	}
	if (/\bdraft\b.*(reply|response)\b/.test(text)) return "draft_reply";
	if (/\b(draft|compose)\b.*(follow.?up|check.?in|bump)\b/.test(text))
		return "draft_followup";
	if (/\b(respond|reply)\b.*(email|inbox|message)\b/.test(text))
		return "respond";
	if (/\b(send|confirm)\b.*\bdraft\b/.test(text)) return "send_draft";
	if (/\b(schedule|defer|send later)\b/.test(text) && /\bdraft\b/.test(text))
		return "schedule_draft_send";
	if (/\b(triage|prioritize|priority|needs reply|needs answer)\b/.test(text))
		return "triage";
	if (
		/\b(inbox|unread|digest)\b/.test(text) &&
		/\b(list|show|what'?s|summary|summarize)\b/.test(text)
	) {
		return "list_inbox";
	}

	const hasContact = textParam(params.contact) || textParam(params.entityId);
	if (
		hasContact &&
		/\b(read|recent|history|conversation|messages with|chat with|dms? with)\b/.test(
			text,
		)
	) {
		return "read_with_contact";
	}

	if (
		(params.query || /\b(search|find)\b/.test(text)) &&
		/\b(inbox|email|gmail|mail)\b/.test(text)
	) {
		return "search_inbox";
	}
	if (params.query || /\b(search|find)\b/.test(text)) return "search";
	if (params.emoji || /\b(react|reaction)\b/.test(text)) return "react";
	if (/\b(edit|update)\b/.test(text)) return "edit";
	if (/\b(delete|remove|unsend)\b/.test(text)) return "delete";
	if (/\b(unpin|pin)\b/.test(text)) return "pin";
	if (/\bjoin\b/.test(text)) return "join";
	if (/\bleave\b/.test(text)) return "leave";
	if (/\b(user info|lookup user|get user)\b/.test(text)) return "get_user";
	if (/\blist\b.*(server|workspace|guild)\b/.test(text)) return "list_servers";
	if (/\blist\b.*(channel|room|chat|group)\b/.test(text))
		return "list_channels";
	if (/\b(read|recent|history)\b/.test(text)) return "read_channel";
	return "send";
}

// ---------------------------------------------------------------------------
// MessageConnector access (in-process — no HTTP)
// ---------------------------------------------------------------------------

type RuntimeWithLegacySendHandlers = IAgentRuntime & {
	sendHandlers?: Map<string, unknown>;
	getMessageConnectors?: () => MessageConnector[];
};

type ConnectorWithHooks = MessageConnector & {
	fetchMessages?: (
		context: MessageConnectorQueryContext,
		opts: {
			target: TargetInfo;
			limit: number;
			cursor?: string;
			before?: string;
			after?: string;
		},
	) => Promise<Memory[]> | Memory[];
	searchMessages?: (
		context: MessageConnectorQueryContext,
		opts: {
			query: string;
			target?: TargetInfo;
			limit: number;
			cursor?: string;
			before?: string;
			after?: string;
		},
	) => Promise<Memory[]> | Memory[];
	listServers?: (
		context: MessageConnectorQueryContext,
	) =>
		| Promise<Array<{ id?: string; name?: string }>>
		| Array<{ id?: string; name?: string }>;
	joinHandler?: (
		runtime: IAgentRuntime,
		payload: {
			roomId?: UUID;
			channelId?: string;
			serverId?: string;
			alias?: string;
			invite?: string;
			target?: TargetInfo;
		},
	) =>
		| Promise<{ id?: UUID } | null | undefined>
		| { id?: UUID }
		| null
		| undefined;
	leaveHandler?: (
		runtime: IAgentRuntime,
		payload: {
			roomId?: UUID;
			channelId?: string;
			serverId?: string;
			alias?: string;
			target?: TargetInfo;
		},
	) => Promise<void> | void;
	reactHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string; emoji: string },
	) => Promise<void> | void;
	editHandler?: (
		runtime: IAgentRuntime,
		payload: {
			target: TargetInfo;
			messageId: string;
			content: Content;
		},
	) =>
		| Promise<Memory | { id?: UUID } | undefined>
		| Memory
		| { id?: UUID }
		| undefined;
	deleteHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string },
	) => Promise<void> | void;
	pinHandler?: (
		runtime: IAgentRuntime,
		payload: { target: TargetInfo; messageId: string; pin: boolean },
	) => Promise<void> | void;
	getUser?: (
		runtime: IAgentRuntime,
		query: { userId?: string; username?: string; handle?: string },
	) => Promise<unknown> | unknown;
	contentShaping?: {
		postProcess?: (text: string) => string;
		constraints?: { maxLength?: number };
	};
};

function listMessageConnectors(runtime: IAgentRuntime): ConnectorWithHooks[] {
	const rt = runtime as RuntimeWithLegacySendHandlers;
	if (typeof rt.getMessageConnectors === "function") {
		return rt.getMessageConnectors() as ConnectorWithHooks[];
	}
	const sendHandlers = rt.sendHandlers;
	if (!(sendHandlers instanceof Map)) return [];
	return Array.from(sendHandlers.keys())
		.sort((a, b) => a.localeCompare(b))
		.map(
			(source): ConnectorWithHooks => ({
				source,
				label: source
					.replace(/[_-]+/g, " ")
					.replace(/\b\w/g, (c) => c.toUpperCase()),
				capabilities: ["send_message"],
				supportedTargetKinds: [],
				contexts: [],
			}),
		);
}

function connectorAliases(connector: MessageConnector): string[] {
	const aliases: string[] = [connector.source, connector.label];
	if (connector.accountId) aliases.push(connector.accountId);
	if (connector.account?.accountId) aliases.push(connector.account.accountId);
	if (connector.account?.label) aliases.push(connector.account.label);
	if (connector.account?.name) aliases.push(connector.account.name);
	const metadataAliases = (
		connector.metadata as { aliases?: unknown } | undefined
	)?.aliases;
	if (Array.isArray(metadataAliases)) {
		for (const alias of metadataAliases) {
			if (typeof alias === "string" && alias.trim().length > 0)
				aliases.push(alias);
		}
	}
	return aliases;
}

function connectorMatchesAccount(
	connector: ConnectorWithHooks,
	accountId: string | undefined,
): boolean {
	if (!accountId) return true;
	const normalized = normalizeComparable(accountId);
	return connectorAliases(connector).some(
		(alias) => normalizeComparable(alias) === normalized,
	);
}

function findConnectorBySource(
	connectors: ConnectorWithHooks[],
	source: string | undefined,
): ConnectorWithHooks | undefined {
	if (!source) return undefined;
	const normalized = normalizeComparable(source);
	return connectors.find((connector) =>
		connectorAliases(connector).some(
			(alias) => normalizeComparable(alias) === normalized,
		),
	);
}

function connectorsWithHook<K extends keyof ConnectorWithHooks>(
	runtime: IAgentRuntime,
	hook: K,
): ConnectorWithHooks[] {
	return listMessageConnectors(runtime).filter(
		(connector) => typeof connector[hook] === "function",
	);
}

function buildQueryContext(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	source: string | undefined,
	target?: TargetInfo,
	connector?: ConnectorWithHooks,
): MessageConnectorQueryContext {
	return {
		runtime,
		roomId: message.roomId,
		entityId: message.entityId,
		source,
		accountId: connector?.accountId,
		account: connector?.account,
		target,
		contexts: getActiveRoutingContextsForTurn(state, message),
		metadata: { messageText: message.content?.text },
	};
}

function selectConnectorForOp(
	connectors: ConnectorWithHooks[],
	source: string | undefined,
	currentSource: string | undefined,
	op: MessageOperation,
	accountId?: string,
): { connector: ConnectorWithHooks } | { error: ActionResult } {
	if (connectors.length === 0) {
		return {
			error: opFailure(
				op,
				"NO_CONNECTORS_REGISTERED",
				`MESSAGE op=${op} has no registered connectors.`,
			),
		};
	}
	const explicit = source
		? connectors.find(
				(connector) =>
					connectorAliases(connector).some(
						(alias) =>
							normalizeComparable(alias) === normalizeComparable(source),
					) && connectorMatchesAccount(connector, accountId),
			)
		: undefined;
	const sourceExists = source
		? Boolean(findConnectorBySource(connectors, source))
		: false;
	if (source && !explicit) {
		return {
			error: opFailure(
				op,
				sourceExists
					? "ACCOUNT_CONNECTOR_NOT_FOUND"
					: "SOURCE_CONNECTOR_NOT_FOUND",
				sourceExists
					? `No message connector for account "${accountId}" on source "${source}".`
					: `No message connector for source "${source}". Available: ${connectors.map((c) => c.source).join(", ")}.`,
			),
		};
	}
	if (explicit) return { connector: explicit };
	const fallback = currentSource
		? connectors.find(
				(connector) =>
					findConnectorBySource([connector], currentSource) &&
					connectorMatchesAccount(connector, accountId),
			)
		: undefined;
	if (fallback) return { connector: fallback };
	const accountScoped = connectors.filter((connector) =>
		connectorMatchesAccount(connector, accountId),
	);
	if (accountId && accountScoped.length === 1) {
		const sole = accountScoped[0];
		if (sole) return { connector: sole };
	}
	if (accountId && accountScoped.length === 0) {
		return {
			error: opFailure(
				op,
				"ACCOUNT_CONNECTOR_NOT_FOUND",
				`MESSAGE op=${op} has no connector for account "${accountId}".`,
			),
		};
	}
	if (accountScoped.length > 1) {
		return {
			error: opFailure(
				op,
				"SOURCE_AMBIGUOUS",
				`MESSAGE op=${op} needs a source/account. Choose one of: ${accountScoped
					.map((c) => (c.accountId ? `${c.source}:${c.accountId}` : c.source))
					.join(", ")}.`,
			),
		};
	}
	const fallbackConnector = accountScoped[0];
	if (!fallbackConnector) {
		return {
			error: opFailure(
				op,
				"NO_CONNECTORS_REGISTERED",
				`MESSAGE op=${op} could not resolve a connector.`,
			),
		};
	}
	return { connector: fallbackConnector };
}

// ---------------------------------------------------------------------------
// Target resolution helpers
// ---------------------------------------------------------------------------

function explicitTargetFromParams(
	source: string,
	params: ParamRecord,
): { target?: TargetInfo; query?: string } {
	const targetText =
		textParam(params.target) ??
		textParam(params.channel) ??
		textParam(params.channelName) ??
		textParam(params.room) ??
		textParam(params.user) ??
		textParam(params.username) ??
		textParam(params.handle);
	const roomId = textParam(params.roomId);
	const channelId =
		textParam(params.channelId) ??
		textParam(params.channel) ??
		(!roomId && targetText && !isUuidLike(targetText) ? targetText : undefined);
	const entityId =
		textParam(params.entityId) ??
		textParam(params.userId) ??
		(targetText && isUuidLike(targetText) ? targetText : undefined);
	const serverId = textParam(params.serverId) ?? textParam(params.server);
	const threadId = textParam(params.threadId) ?? textParam(params.thread);

	if (
		!targetText &&
		!roomId &&
		!channelId &&
		!entityId &&
		!serverId &&
		!threadId
	) {
		return {};
	}
	return {
		query: targetText,
		target: {
			source,
			roomId: roomId as UUID | undefined,
			channelId,
			serverId,
			entityId: entityId as UUID | undefined,
			threadId,
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

async function resolveOptionalTarget(
	connector: ConnectorWithHooks,
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: MessageOperation,
): Promise<{ target?: TargetInfo; error?: ActionResult }> {
	const explicit = explicitTargetFromParams(connector.source, params);
	if (explicit.target) explicit.target.accountId ??= connector.accountId;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		explicit.target,
		connector,
	);

	if (explicit.query && connector.resolveTargets) {
		try {
			const matches = await connector.resolveTargets(explicit.query, context);
			if (matches.length === 1) {
				const sole = matches[0];
				if (!sole) {
					return {
						error: opFailure(
							op,
							"TARGET_RESOLVE_FAILED",
							"Target resolution returned an empty match.",
						),
					};
				}
				const target = {
					...sole.target,
					accountId: sole.target.accountId ?? connector.accountId,
				};
				return { target };
			}
			if (matches.length > 1) {
				const sorted = [...matches].sort(
					(a, b) => (b.score ?? 0) - (a.score ?? 0),
				);
				const [top, second] = sorted;
				if (top && second && (top.score ?? 0) > (second.score ?? 0) + 0.12) {
					return {
						target: {
							...top.target,
							accountId: top.target.accountId ?? connector.accountId,
						},
					};
				}
				return {
					error: opFailure(
						op,
						"TARGET_AMBIGUOUS",
						`Target ambiguous for ${connector.label}. Choose one of:\n` +
							sorted
								.slice(0, 8)
								.map(
									(t, i) =>
										`${i + 1}. ${t.label ?? targetLabel(t.target)} (${t.kind ?? "target"})`,
								)
								.join("\n"),
					),
				};
			}
		} catch (error) {
			logger.warn(
				`[MESSAGE/${op}] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return { target: explicit.target };
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function opFailure(
	op: MessageOperation,
	code: string,
	text: string,
	extra?: Record<string, unknown>,
): ActionResult {
	return {
		success: false,
		text,
		values: { success: false, error: code },
		data: {
			actionName: "MESSAGE",
			operation: op,
			error: code,
			...(extra ?? {}),
		},
	};
}

function opSuccess(
	op: MessageOperation,
	text: string,
	data: Record<string, unknown>,
): ActionResult {
	return {
		success: true,
		text,
		values: { success: true },
		data: { actionName: "MESSAGE", operation: op, ...data },
	};
}

function invalidOpResult(op: MessageOperation, text: string): ActionResult {
	return opFailure(op, "MESSAGE_INVALID", text);
}

function opErrorWrap(op: MessageOperation, error: unknown): ActionResult {
	const text = error instanceof Error ? error.message : String(error);
	logger.error(`[MESSAGE/${op}] ${text}`);
	return opFailure(
		op,
		`MESSAGE_${op.toUpperCase()}_FAILED`,
		`MESSAGE op=${op} failed: ${text}`,
	);
}

// ---------------------------------------------------------------------------
// op=send (folded from sendMessage.ts)
// ---------------------------------------------------------------------------

const ADMIN_TARGETS = new Set(["admin", "owner"]);
const VALID_URGENCIES = new Set(["normal", "important", "urgent"]);
const AMBIGUITY_DELTA = 0.12;
const AMBIGUITY_SCORE = 0.68;

type SourceResolution = "exact" | "inferred" | "defaulted";

type NormalizedSendParams = {
	target?: string;
	source?: string;
	accountId?: string;
	sourceResolution: SourceResolution;
	targetKind?: MessageTargetKind;
	message: string;
	thread?: string;
	attachments?: Media[];
	urgency: string;
};

type SendCandidate = {
	connector: ConnectorWithHooks;
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
			candidate: SendCandidate;
			sourceResolution: SourceResolution;
	  }
	| {
			status: "ambiguous";
			text: string;
			candidates: SendCandidate[];
			sourceResolution: SourceResolution;
	  }
	| {
			status: "missing_connector" | "missing_target" | "unsupported";
			text: string;
			error: string;
			sourceResolution: SourceResolution;
	  };

function normalizeTargetKind(value: unknown): MessageTargetKind | undefined {
	const text = textParam(value);
	if (!text) return undefined;
	const n = text.toLowerCase();
	if (n === "room") return "room";
	if (n === "channel") return "channel";
	if (n === "thread") return "thread";
	if (n === "user") return "user";
	if (n === "person" || n === "recipient" || n === "contact") return "contact";
	if (n === "group") return "group";
	if (n === "server") return "server";
	if (n === "email") return "email";
	if (n === "sms" || n === "phone") return "phone";
	return n as MessageTargetKind;
}

function kindAliases(kind: MessageTargetKind): Set<string> {
	const n = String(kind).toLowerCase();
	if (n === "room") return new Set(["room", "channel", "group"]);
	if (n === "channel") return new Set(["channel", "room", "group"]);
	if (n === "user") return new Set(["user", "contact"]);
	if (n === "contact") return new Set(["contact", "user"]);
	if (n === "phone") return new Set(["phone", "sms", "contact"]);
	if (n === "email") return new Set(["email", "contact"]);
	return new Set([n]);
}

function kindsCompatible(
	requested: MessageTargetKind | undefined,
	actual: MessageTargetKind | undefined,
): boolean {
	if (!requested || !actual) return true;
	return kindAliases(requested).has(String(actual).toLowerCase());
}

function connectorSupportsKind(
	connector: ConnectorWithHooks,
	kind: MessageTargetKind | undefined,
): boolean {
	if (!kind || connector.supportedTargetKinds.length === 0) return true;
	const aliases = kindAliases(kind);
	return connector.supportedTargetKinds.some((k) =>
		aliases.has(String(k).toLowerCase()),
	);
}

function inferSourceFromTarget(
	target: string | undefined,
	connectors: ConnectorWithHooks[],
): { target?: string; source?: string } {
	if (!target) return {};
	const prefixMatch = target.match(
		/^([a-z0-9_-][a-z0-9 _-]{1,40})\s*[:/]\s*(.+)$/i,
	);
	if (prefixMatch?.[1] && prefixMatch[2]) {
		const connector = findConnectorBySource(connectors, prefixMatch[1]);
		if (connector)
			return { source: connector.source, target: prefixMatch[2].trim() };
	}
	const onMatch = target.match(
		/^(.+?)\s+(?:on|via|through)\s+([a-z0-9 _-]{2,40})$/i,
	);
	if (onMatch?.[1] && onMatch[2]) {
		const connector = findConnectorBySource(connectors, onMatch[2]);
		if (connector)
			return { source: connector.source, target: onMatch[1].trim() };
	}
	return { target };
}

function inferSourceFromText(
	text: string | undefined,
	connectors: ConnectorWithHooks[],
): string | undefined {
	if (!text) return undefined;
	for (const connector of connectors) {
		for (const alias of connectorAliases(connector)) {
			const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const pattern = new RegExp(
				`\\b(?:on|via|through|using)\\s+${escaped}\\b`,
				"i",
			);
			if (pattern.test(text)) return connector.source;
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
		if (raw) return raw.replace(/^["']|["']$/g, "").trim();
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
		.filter((v): v is string => typeof v === "string")
		.join("\n");
	return chunks.slice(-4000);
}

function inferTargetFromRecentConversation(
	state: State | undefined,
): string | undefined {
	const recent = recentTextFromState(state);
	if (!recent) return undefined;
	const matches = Array.from(recent.matchAll(/[@#][\w.-]{2,}/g));
	return matches.at(-1)?.[0]?.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeAttachments(value: unknown): Media[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attachments: Media[] = [];
	for (const item of value) {
		if (!isRecord(item)) continue;
		const url = textParam(item.url);
		if (!url) continue;
		attachments.push({ ...item, id: textParam(item.id) ?? url, url } as Media);
	}
	return attachments.length > 0 ? attachments : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function connectorSendAsMetadata(
	message: Memory,
): Record<string, unknown> | undefined {
	const metadata = recordValue(message.content?.metadata);
	return (
		recordValue(metadata?.connectorSendAs) ??
		recordValue(metadata?.connectorAccount)
	);
}

function accountIdFromParams(
	raw: ParamRecord,
	message: Memory,
): string | undefined {
	const metadata = recordValue(message.content?.metadata);
	const sendAs = connectorSendAsMetadata(message);
	return (
		textParam(raw.accountId) ??
		textParam(raw.connectorAccountId) ??
		textParam(sendAs?.accountId) ??
		textParam(metadata?.accountId)
	);
}

function sourceFromSendAs(message: Memory): string | undefined {
	const sendAs = connectorSendAsMetadata(message);
	return textParam(sendAs?.source);
}

function sourceFromParams(
	raw: ParamRecord,
	message: Memory,
): string | undefined {
	return (
		textParam(raw.source) ??
		textParam(raw.platform) ??
		sourceFromSendAs(message)
	);
}

function normalizeSendParams(
	raw: ParamRecord,
	message: Memory,
	state: State | undefined,
	connectors: ConnectorWithHooks[],
): NormalizedSendParams {
	let target =
		textParam(raw.target) ??
		textParam(raw.recipient) ??
		textParam(message.content.target) ??
		inferTargetFromText(message.content.text) ??
		inferTargetFromRecentConversation(state);
	let source = sourceFromParams(raw, message);
	const accountId = accountIdFromParams(raw, message);
	let sourceResolution: SourceResolution = source ? "exact" : "inferred";

	const fromTarget = inferSourceFromTarget(target, connectors);
	if (!source && fromTarget.source) {
		source = fromTarget.source;
		sourceResolution = "inferred";
	}
	if (fromTarget.target) target = fromTarget.target;

	if (!source) {
		source = inferSourceFromText(message.content.text, connectors);
		if (source) sourceResolution = "inferred";
	}

	const messageText = textParam(raw.message) ?? textParam(raw.text) ?? "";
	const targetKind = normalizeTargetKind(raw.targetKind ?? raw.targetType);

	return {
		target,
		source,
		accountId,
		sourceResolution,
		targetKind,
		message: messageText,
		thread: textParam(raw.thread),
		attachments: normalizeAttachments(raw.attachments),
		urgency: textParam(raw.urgency) ?? "normal",
	};
}

function queryMatchesCandidate(
	query: string | undefined,
	candidate: MessageConnectorTarget,
): boolean {
	if (!query) return true;
	const nq = normalizeComparable(query);
	const stripped = normalizeComparable(stripTargetPrefix(query));
	const haystack = normalizeComparable(
		[
			candidate.label,
			candidate.description,
			candidate.target.channelId,
			candidate.target.roomId,
			candidate.target.entityId,
			candidate.target.threadId,
			candidate.target.serverId,
			...(candidate.metadata
				? Object.values(candidate.metadata).filter(
						(v): v is string => typeof v === "string",
					)
				: []),
		]
			.filter(Boolean)
			.join(" "),
	);
	return (
		haystack.includes(nq) ||
		haystack.includes(stripped) ||
		normalizeComparable(candidate.label) === stripped
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
	if (query && queryMatchesCandidate(query, raw)) score += 0.12;
	if (targetKind && kindsCompatible(targetKind, raw.kind)) score += 0.08;
	if (sourceWasExact) score += 0.08;
	if (reasons.includes("resolveTargets")) score += 0.08;
	return Math.max(0, Math.min(1, score));
}

function normalizeHookCandidate(
	connector: ConnectorWithHooks,
	raw: MessageConnectorTarget,
	query: string | undefined,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
	baseScore: number,
	reasons: string[],
): SendCandidate | null {
	if (!kindsCompatible(targetKind, raw.kind)) return null;
	if (!queryMatchesCandidate(query, raw)) return null;
	const target = {
		...raw.target,
		source: raw.target.source || connector.source,
		accountId: raw.target.accountId ?? connector.accountId,
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
	connector: ConnectorWithHooks,
	query: string | undefined,
	context: MessageConnectorQueryContext,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): Promise<SendCandidate[]> {
	const candidates: SendCandidate[] = [];

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
				`[MESSAGE/send] resolveTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	if (connector.listRecentTargets) {
		try {
			const recent = await connector.listRecentTargets(context);
			for (const raw of recent) {
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
				`[MESSAGE/send] listRecentTargets failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
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
				`[MESSAGE/send] listRooms failed for ${connector.source}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return candidates;
}

function explicitSendTarget(
	connector: ConnectorWithHooks,
	rawTarget: string,
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): SendCandidate {
	let kind = targetKind;
	let value = rawTarget.trim();
	const fieldMatch = value.match(
		/^(room|channel|server|entity|user|contact|thread|group|email|phone):(.+)$/i,
	);
	if (fieldMatch?.[1] && fieldMatch[2]) {
		kind = normalizeTargetKind(fieldMatch[1]);
		value = fieldMatch[2].trim();
	}
	const target = {
		source: connector.source,
		accountId: connector.accountId,
	} as TargetInfo;
	const stripped = stripTargetPrefix(value);

	if (kind === "room") {
		if (isUuidLike(value)) target.roomId = value;
		else target.channelId = stripped;
	} else if (kind === "channel" || kind === "group") {
		target.channelId = stripped;
	} else if (kind === "server") {
		target.serverId = value;
	} else if (kind === "thread") {
		target.threadId = value;
	} else if (kind === "phone" || kind === "email") {
		target.entityId = value as UUID;
		target.channelId = value;
	} else if (kind === "user" || kind === "contact") {
		target.entityId = stripped as UUID;
	} else if (value.startsWith("#")) {
		kind = "channel";
		target.channelId = stripped;
	} else if (value.startsWith("@")) {
		kind = "user";
		target.entityId = stripped as UUID;
	} else if (isUuidLike(value)) {
		kind = "room";
		target.roomId = value;
	} else {
		kind = targetKind ?? "contact";
		target.entityId = stripped as UUID;
	}

	return {
		connector,
		target,
		label: value,
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
		if (typeof value === "string" && value.trim().length > 0)
			return value.trim();
		if (typeof value === "number") return String(value);
	}
	return undefined;
}

async function collectEntityCandidates(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	query: string | undefined,
	connectors: ConnectorWithHooks[],
	targetKind: MessageTargetKind | undefined,
	sourceWasExact: boolean,
): Promise<SendCandidate[]> {
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
			{ ...message, content: { ...message.content, text: query } },
			state ?? ({ values: {}, data: {}, text: "" } as State),
		);
		if (!entity?.id) return [];

		const label = entity.names?.[0] ?? query;
		const candidates: SendCandidate[] = [];
		for (const connector of connectors) {
			if (!connectorSupportsKind(connector, targetKind ?? "contact")) continue;
			const matchingComponent = entity.components?.find(
				(c) =>
					normalizeComparable(c.type) === normalizeComparable(connector.source),
			);
			const target = {
				source: connector.source,
				accountId: connector.accountId,
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
				if (channelId) target.channelId = channelId;
				const roomId = componentString(matchingComponent, ["roomId"]);
				if (roomId) target.roomId = roomId as UUID;
				const serverId = componentString(matchingComponent, ["serverId"]);
				if (serverId) target.serverId = serverId;
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
			`[MESSAGE/send] entity resolution failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

async function currentRoomCandidate(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	connector: ConnectorWithHooks,
	sourceWasExact: boolean,
): Promise<SendCandidate> {
	const room = state?.data?.room ?? (await runtime.getRoom(message.roomId));
	const target = {
		source: connector.source,
		accountId: connector.accountId,
		roomId: (room?.id ?? message.roomId) as UUID,
	} as TargetInfo;
	if (room?.channelId) target.channelId = room.channelId;
	if (room?.serverId) target.serverId = room.serverId;
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

function dedupeCandidates(candidates: SendCandidate[]): SendCandidate[] {
	const byKey = new Map<string, SendCandidate>();
	for (const c of candidates) {
		const key = [
			c.connector.source,
			c.connector.accountId,
			c.target.roomId,
			c.target.channelId,
			c.target.serverId,
			c.target.entityId,
			c.target.threadId,
		].join("|");
		const existing = byKey.get(key);
		if (!existing || c.score > existing.score) byKey.set(key, c);
	}
	return Array.from(byKey.values()).sort((l, r) => {
		if (r.score !== l.score) return r.score - l.score;
		return l.label.localeCompare(r.label);
	});
}

function formatCandidates(candidates: SendCandidate[]): string {
	return candidates
		.slice(0, 6)
		.map((c, i) => {
			const kind = c.kind ? ` kind=${c.kind}` : "";
			return `${i + 1}. ${c.label} source=${c.connector.source}${kind} score=${c.score.toFixed(2)} target=${JSON.stringify(c.target)}`;
		})
		.join("\n");
}

async function resolveAdminTarget(
	runtime: IAgentRuntime,
	message: Memory,
	connectors: ConnectorWithHooks[],
	params: NormalizedSendParams,
): Promise<SendCandidate | null> {
	if (!params.target || !ADMIN_TARGETS.has(params.target.toLowerCase()))
		return null;
	const source = params.source ?? "client_chat";
	const connector = findConnectorBySource(connectors, source);
	if (!connector) return null;
	const ownerId =
		(await resolveCanonicalOwnerIdForMessage(runtime, message)) ??
		stringToUuid(`${runtime.character?.name ?? runtime.agentId}-admin-entity`);
	return {
		connector,
		target: {
			source: connector.source,
			accountId: connector.accountId,
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
	connectors: ConnectorWithHooks[],
	params: NormalizedSendParams,
): Promise<TargetResolution> {
	if (connectors.length === 0) {
		return {
			status: "missing_connector",
			text: "No message connectors are registered. Connect a messaging connector before MESSAGE op=send.",
			error: "NO_CONNECTORS_REGISTERED",
			sourceResolution: params.sourceResolution,
		};
	}

	const sourceScoped = params.source
		? connectors.filter((connector) =>
				connectorAliases(connector).some(
					(alias) =>
						normalizeComparable(alias) === normalizeComparable(params.source),
				),
			)
		: connectors;
	if (params.source && sourceScoped.length === 0) {
		return {
			status: "missing_connector",
			text: `No message connector for source "${params.source}". Available: ${connectors.map((c) => c.source).join(", ")}.`,
			error: "SOURCE_CONNECTOR_NOT_FOUND",
			sourceResolution: "exact",
		};
	}
	const accountScoped = sourceScoped.filter((connector) =>
		connectorMatchesAccount(connector, params.accountId),
	);
	if (params.accountId && accountScoped.length === 0) {
		return {
			status: "missing_connector",
			text: `No message connector for account "${params.accountId}"${params.source ? ` on ${params.source}` : ""}.`,
			error: "ACCOUNT_CONNECTOR_NOT_FOUND",
			sourceResolution: params.sourceResolution,
		};
	}
	if (params.source && !params.accountId && accountScoped.length > 1) {
		return {
			status: "ambiguous",
			text:
				`MESSAGE op=send needs a connector account for ${params.source}. Choose one of: ` +
				accountScoped
					.map((connector) =>
						connector.accountId
							? `${connector.source}:${connector.accountId}`
							: connector.source,
					)
					.join(", "),
			candidates: [],
			sourceResolution: "exact",
		};
	}
	const exact =
		params.source && accountScoped.length === 1 ? accountScoped[0] : undefined;

	const adminCandidate = await resolveAdminTarget(
		runtime,
		message,
		accountScoped,
		params,
	);
	if (adminCandidate) {
		return {
			status: "resolved",
			candidate: adminCandidate,
			sourceResolution: params.source ? params.sourceResolution : "defaulted",
		};
	}

	const sourceWasExact = Boolean(params.source && exact);
	let considered = exact
		? [exact]
		: accountScoped.filter((c) => connectorSupportsKind(c, params.targetKind));
	if (considered.length === 0) {
		return {
			status: "unsupported",
			text: `No connector supports targetKind "${params.targetKind}".`,
			error: "TARGET_KIND_UNSUPPORTED",
			sourceResolution: params.sourceResolution,
		};
	}

	if (!params.target && !params.source) {
		const currentSource = textParam(message.content.source);
		const currentConnector = findConnectorBySource(considered, currentSource);
		if (currentConnector) considered = [currentConnector];
	}

	const candidates: SendCandidate[] = [];

	for (const connector of considered) {
		const context = buildQueryContext(
			runtime,
			message,
			state,
			connector.source,
			undefined,
			connector,
		);
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
			considered,
			params.targetKind,
			sourceWasExact,
		)),
	);

	if (params.target) {
		for (const connector of considered) {
			candidates.push(
				explicitSendTarget(
					connector,
					params.target,
					params.targetKind,
					sourceWasExact,
				),
			);
		}
	} else if (considered.length === 1) {
		const soleConnector = considered[0];
		if (soleConnector) {
			candidates.push(
				await currentRoomCandidate(
					runtime,
					message,
					state,
					soleConnector,
					sourceWasExact,
				),
			);
		}
	}

	const sorted = dedupeCandidates(candidates);
	if (sorted.length === 0) {
		return {
			status: "missing_target",
			text: "MESSAGE op=send could not resolve a target. Provide target and (if needed) source/targetKind.",
			error: "TARGET_NOT_RESOLVED",
			sourceResolution: params.sourceResolution,
		};
	}

	const top = sorted[0];
	if (top === undefined) {
		return {
			status: "missing_target",
			text: "MESSAGE op=send could not resolve a target. Provide target and (if needed) source/targetKind.",
			error: "TARGET_NOT_RESOLVED",
			sourceResolution: params.sourceResolution,
		};
	}
	const ambiguous = sorted.filter(
		(c) => c !== top && Math.abs(top.score - c.score) <= AMBIGUITY_DELTA,
	);
	if (
		ambiguous.length > 0 &&
		(!params.source || top.score >= AMBIGUITY_SCORE)
	) {
		const choices = [top, ...ambiguous];
		return {
			status: "ambiguous",
			text:
				"MESSAGE op=send found multiple plausible targets. Specify a more exact target/source or pick one:\n" +
				formatCandidates(choices),
			candidates: choices,
			sourceResolution: params.source ? "exact" : "inferred",
		};
	}

	if (top.score < 0.5 && considered.length > 1) {
		return {
			status: "ambiguous",
			text:
				"MESSAGE op=send needs a more specific target/source. Available connectors:\n" +
				connectors
					.map((c, i) => `${i + 1}. ${c.source} (${c.label})`)
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
					: considered.length === 1
						? "defaulted"
						: "inferred",
	};
}

function buildContent(params: NormalizedSendParams): Content {
	const content: Content = {
		text: params.message,
		source: params.source,
		metadata: {
			urgency: params.urgency,
			targetKind: params.targetKind,
			accountId: params.accountId,
		},
	};
	if (params.attachments) content.attachments = params.attachments;
	return content;
}

function applyContentShaping(
	connector: ConnectorWithHooks,
	content: Content,
): Content {
	let text = typeof content.text === "string" ? content.text : "";
	const shaping = connector.contentShaping;
	if (text && typeof shaping?.postProcess === "function")
		text = shaping.postProcess(text);
	const maxLength = shaping?.constraints?.maxLength;
	if (
		text &&
		typeof maxLength === "number" &&
		Number.isFinite(maxLength) &&
		maxLength > 0 &&
		text.length > maxLength
	) {
		text = text.slice(0, Math.floor(maxLength));
	}
	return text === content.text ? content : { ...content, text };
}

function channelTypeForKind(
	kind: MessageTargetKind | undefined,
): Content["channelType"] {
	if (
		kind === "user" ||
		kind === "contact" ||
		kind === "email" ||
		kind === "phone"
	)
		return ChannelType.DM;
	if (kind === "thread") return ChannelType.THREAD;
	if (kind === "server") return ChannelType.WORLD;
	return ChannelType.GROUP;
}

async function ensureOutboundRoom(
	runtime: IAgentRuntime,
	source: string,
	target: TargetInfo,
	label: string,
	kind: MessageTargetKind | undefined,
): Promise<{ roomId: UUID; worldId: UUID }> {
	const serverPart = target.serverId ?? "default";
	const targetPart =
		target.roomId ??
		target.channelId ??
		target.entityId ??
		target.threadId ??
		label ??
		"default";
	const worldId = stringToUuid(
		`${runtime.agentId}:${source}:message-world:${serverPart}`,
	) as UUID;
	const roomId = isUuidLike(target.roomId ?? "")
		? (target.roomId as UUID)
		: (stringToUuid(
				`${runtime.agentId}:${source}:message-room:${serverPart}:${targetPart}`,
			) as UUID);
	await runtime.ensureWorldExists({
		id: worldId,
		name: `${source}${target.serverId ? ` ${target.serverId}` : ""}`,
		agentId: runtime.agentId,
		messageServerId: target.serverId
			? (stringToUuid(`${source}:server:${target.serverId}`) as UUID)
			: undefined,
		metadata: { source, type: "message_world", serverId: target.serverId },
	});
	await runtime.ensureRoomExists({
		id: roomId,
		name: label,
		source,
		type: channelTypeForKind(kind) ?? ChannelType.GROUP,
		channelId: target.channelId ?? target.roomId ?? target.entityId,
		messageServerId: target.serverId
			? (stringToUuid(`${source}:server:${target.serverId}`) as UUID)
			: undefined,
		worldId,
		metadata: {
			source,
			type: "outbound_message_target",
			target: {
				source: target.source,
				roomId: target.roomId,
				channelId: target.channelId,
				serverId: target.serverId,
				entityId: target.entityId,
				threadId: target.threadId,
			},
			targetKind: kind,
		},
	});
	await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
	return { roomId, worldId };
}

async function persistOutboundMemory(params: {
	runtime: IAgentRuntime;
	source: string;
	target: TargetInfo;
	label: string;
	kind?: MessageTargetKind;
	content: Content;
	sentMemory?: Memory;
	persist: boolean;
}): Promise<Memory | undefined> {
	if (!params.persist) return params.sentMemory ?? undefined;
	const { runtime, source, target, label, kind, content, sentMemory } = params;
	try {
		const { roomId, worldId } = await ensureOutboundRoom(
			runtime,
			source,
			target,
			label,
			kind,
		);
		const platformMessageId =
			typeof sentMemory?.metadata === "object"
				? (sentMemory.metadata as { messageIdFull?: string }).messageIdFull
				: undefined;
		const memory: Memory = {
			...(sentMemory ?? {}),
			id:
				sentMemory?.id ??
				(stringToUuid(
					platformMessageId
						? `${source}:message:${platformMessageId}`
						: `${runtime.agentId}:${source}:message:${label}:${Date.now()}:${content.text ?? ""}`,
				) as UUID),
			entityId: sentMemory?.entityId ?? runtime.agentId,
			agentId: sentMemory?.agentId ?? runtime.agentId,
			roomId: sentMemory?.roomId ?? roomId,
			worldId: sentMemory?.worldId ?? worldId,
			content: {
				...content,
				...(sentMemory?.content ?? {}),
				source,
				channelType:
					sentMemory?.content?.channelType ?? channelTypeForKind(kind),
			},
			metadata: {
				type: "message",
				source,
				provider: source,
				...(sentMemory?.metadata ?? {}),
				...(platformMessageId ? { messageIdFull: platformMessageId } : {}),
			},
			createdAt: sentMemory?.createdAt ?? Date.now(),
		};
		if (memory.id) {
			await runtime.upsertMemory(memory, "messages");
			return memory;
		}
		const id = await runtime.createMemory(memory, "messages");
		return { ...memory, id };
	} catch (error) {
		runtime.logger.warn(
			{
				src: "MESSAGE/send",
				err: error instanceof Error ? error.message : String(error),
				source,
			},
			"Message sent but target room persistence failed",
		);
		return params.sentMemory ?? undefined;
	}
}

async function persistCurrentChatMemory(args: {
	runtime: IAgentRuntime;
	message: Memory;
	source: string;
	label: string;
	kind?: MessageTargetKind;
	targetMemory?: Memory;
	platformMessageId?: string;
}): Promise<void> {
	const {
		runtime,
		message,
		source,
		label,
		kind,
		targetMemory,
		platformMessageId,
	} = args;
	try {
		const memoryId = stringToUuid(
			[
				message.id ?? message.roomId,
				"MESSAGE",
				source,
				targetMemory?.id ?? platformMessageId ?? Date.now(),
			].join(":"),
		) as UUID;
		const memory: Memory = {
			id: memoryId,
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			roomId: message.roomId,
			worldId: message.worldId,
			content: {
				text: `Message sent via ${source} to ${label}.`,
				actions: ["MESSAGE"],
				source: "agent_action",
				type: "action_result",
				actionName: "MESSAGE",
				actionStatus: "completed",
				responseMessageId: targetMemory?.id,
				metadata: {
					operation: "send",
					targetSource: source,
					targetLabel: label,
					targetKind: kind,
					targetRoomId: targetMemory?.roomId,
					sentMessageId: platformMessageId,
				},
			},
			metadata: {
				type: "message",
				source: "agent_action",
				provider: source,
				actionName: "MESSAGE",
				operation: "send",
				targetSource: source,
				targetLabel: label,
				targetKind: kind,
				targetRoomId: targetMemory?.roomId,
				sentMessageId: platformMessageId,
			} as Memory["metadata"],
			createdAt: Date.now(),
		};
		await runtime.upsertMemory(memory, "messages");
	} catch (error) {
		runtime.logger.warn(
			{
				src: "MESSAGE/send",
				err: error instanceof Error ? error.message : String(error),
				source,
			},
			"Message sent but action memory persistence failed",
		);
	}
}

async function handleSend(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = listMessageConnectors(runtime);
	const normalized = normalizeSendParams(params, message, state, connectors);

	if (!normalized.message && !normalized.attachments) {
		return opFailure(
			"send",
			"INVALID_PARAMETERS",
			"MESSAGE op=send requires message text or attachments.",
		);
	}
	if (!VALID_URGENCIES.has(normalized.urgency)) {
		return opFailure(
			"send",
			"INVALID_PARAMETERS",
			`MESSAGE op=send urgency must be one of normal|important|urgent. Got "${normalized.urgency}".`,
		);
	}

	const resolution = await resolveSendTarget(
		runtime,
		message,
		state,
		connectors,
		normalized,
	);
	if (resolution.status !== "resolved") {
		const code =
			resolution.status === "ambiguous" ? "TARGET_AMBIGUOUS" : resolution.error;
		return opFailure("send", code, resolution.text, {
			sourceResolution: resolution.sourceResolution,
			candidates:
				"candidates" in resolution
					? resolution.candidates.map((c) => ({
							source: c.connector.source,
							label: c.label,
							kind: c.kind,
							score: c.score,
							target: c.target,
						}))
					: undefined,
		});
	}

	const selected = resolution.candidate;
	const target: TargetInfo = normalized.thread
		? { ...selected.target, threadId: normalized.thread }
		: selected.target;
	const content = applyContentShaping(
		selected.connector,
		buildContent({ ...normalized, source: selected.connector.source }),
	);

	let persisted: Memory | undefined;
	try {
		const sent = await runtime.sendMessageToTarget(target, content);
		persisted = await persistOutboundMemory({
			runtime,
			source: selected.connector.source,
			target,
			label: selected.label,
			kind: selected.kind,
			content,
			sentMemory: sent,
			persist: boolParam(params.persist) !== false,
		});
	} catch (error) {
		const text = error instanceof Error ? error.message : String(error);
		logger.error(
			`[MESSAGE/send] failed via ${selected.connector.source}: ${text}`,
		);
		return opFailure(
			"send",
			"MESSAGE_SEND_FAILED",
			`Failed to send via ${selected.connector.label}: ${text}`,
			{
				source: selected.connector.source,
				target,
				targetKind: selected.kind,
				sourceResolution: resolution.sourceResolution,
			},
		);
	}

	const platformMessageId =
		typeof persisted?.metadata === "object"
			? (persisted.metadata as { messageIdFull?: string }).messageIdFull
			: undefined;
	await persistCurrentChatMemory({
		runtime,
		message,
		source: selected.connector.source,
		label: selected.label,
		kind: selected.kind,
		targetMemory: persisted,
		platformMessageId,
	});

	return opSuccess(
		"send",
		`Message sent via ${selected.connector.label} to ${selected.label}.`,
		{
			source: selected.connector.source,
			target,
			targetLabel: selected.label,
			targetKind: selected.kind,
			sourceResolution: resolution.sourceResolution,
			resolutionReasons: selected.reasons,
			thread: normalized.thread,
			urgency: normalized.urgency,
			memoryId: persisted?.id,
			responseMessageId: platformMessageId,
		},
	);
}

// ---------------------------------------------------------------------------
// op=read_channel — channel-centric read.
//
// Two paths:
//   1. If the connector exposes fetchMessages, use it.
//   2. Otherwise, fall back to local `messages` table by resolving the room
//      from the channel/source params (covers the original read-channel leaf behavior).
// ---------------------------------------------------------------------------

const CHANNEL_READ_DEFAULT_LIMIT = 50;
const CHANNEL_READ_MAX_LIMIT = 200;

function parseDateParam(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isNaN(parsed)) return parsed;
	const num = Number(value);
	if (!Number.isNaN(num)) return num > 1e12 ? num : num * 1000;
	return undefined;
}

function connectorReadRequest(
	target: TargetInfo,
	params: ParamRecord,
	limit: number,
) {
	return {
		target,
		limit,
		cursor: textParam(params.cursor),
		before: textParam(params.before),
		after: textParam(params.after),
	};
}

async function fetchRecentMessagesFromConnector(
	connector: ConnectorWithHooks,
	context: MessageConnectorQueryContext,
	params: ParamRecord,
	limit: number,
): Promise<Memory[]> {
	if (!connector.fetchMessages || !connector.listRecentTargets) return [];
	const recent = await connector.listRecentTargets(context);
	const memories: Memory[] = [];
	for (const r of recent.slice(0, 8)) {
		const target = {
			...r.target,
			accountId: r.target.accountId ?? connector.accountId,
		};
		memories.push(
			...((await connector.fetchMessages(
				{ ...context, target },
				connectorReadRequest(target, params, limit),
			)) as Memory[]),
		);
	}
	return memories;
}

async function resolveLocalChannelRoom(
	runtime: IAgentRuntime,
	source: string | undefined,
	channel: string,
): Promise<Room | null> {
	try {
		const direct = await runtime.getRoom(channel as UUID);
		if (direct) return direct;
	} catch {
		// not a uuid
	}
	const agentRooms = await runtime.getRoomsForParticipant(runtime.agentId);
	const channelLower = channel.toLowerCase();
	for (const roomId of agentRooms) {
		try {
			const room = await runtime.getRoom(roomId);
			if (!room) continue;
			const roomRecord = room as Room & { name?: string; source?: string };
			const name = (roomRecord.name ?? "").toLowerCase();
			const roomSource = (roomRecord.source ?? room.type ?? "").toLowerCase();
			if (name === channelLower || name.includes(channelLower)) {
				if (source && roomSource !== source.toLowerCase()) continue;
				return room;
			}
		} catch {
			// ignore individual room lookup failures
		}
	}
	return null;
}

async function handleReadChannel(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = listMessageConnectors(runtime);
	const source = sourceFromParams(params, message);
	const accountId = accountIdFromParams(params, message);
	const channel = textParam(params.channel) ?? textParam(params.target);
	const limit = clampLimit(
		numberParam(params.limit),
		CHANNEL_READ_DEFAULT_LIMIT,
		CHANNEL_READ_MAX_LIMIT,
	);
	const range = textParam(params.range);

	// Prefer in-process connector fetchMessages when available.
	const hookConnectors = connectors.filter(
		(c) => typeof c.fetchMessages === "function",
	);
	const selectedResult =
		source || accountId
			? selectConnectorForOp(
					hookConnectors,
					source,
					message.content?.source,
					"read_channel",
					accountId,
				)
			: undefined;
	if (selectedResult && "error" in selectedResult) return selectedResult.error;
	const selectedConnector =
		selectedResult && "connector" in selectedResult
			? selectedResult.connector
			: hookConnectors.length === 1
				? hookConnectors[0]
				: undefined;

	if (selectedConnector?.fetchMessages) {
		const resolved = await resolveOptionalTarget(
			selectedConnector,
			runtime,
			message,
			state,
			params,
			"read_channel",
		);
		if (resolved.error) return resolved.error;
		const context = buildQueryContext(
			runtime,
			message,
			state,
			selectedConnector.source,
			resolved.target,
			selectedConnector,
		);
		try {
			let memories: Memory[] = [];
			if (resolved.target) {
				memories = (await selectedConnector.fetchMessages(context, {
					...connectorReadRequest(resolved.target, params, limit),
				})) as Memory[];
			} else {
				memories = await fetchRecentMessagesFromConnector(
					selectedConnector,
					context,
					params,
					limit,
				);
				memories = memories
					.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
					.slice(0, limit);
			}
			return opSuccess(
				"read_channel",
				`Read ${memories.length} messages from ${selectedConnector.label}.`,
				{ source: selectedConnector.source, memories },
			);
		} catch (error) {
			return opErrorWrap("read_channel", error);
		}
	}

	if (!channel && hookConnectors.length > 1) {
		const results = await Promise.allSettled(
			hookConnectors.map(async (connector) => {
				const context = buildQueryContext(
					runtime,
					message,
					state,
					connector.source,
					undefined,
					connector,
				);
				return {
					connector,
					memories: await fetchRecentMessagesFromConnector(
						connector,
						context,
						params,
						limit,
					),
				};
			}),
		);
		const memories: Memory[] = [];
		const sources: Array<{
			source: string;
			accountId?: string;
			count: number;
		}> = [];
		for (const result of results) {
			if (result.status === "rejected") {
				logger.warn(
					`[MESSAGE/read_channel] recent connector read failed: ${
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason)
					}`,
				);
				continue;
			}
			memories.push(...result.value.memories);
			sources.push({
				source: result.value.connector.source,
				accountId: result.value.connector.accountId,
				count: result.value.memories.length,
			});
		}
		memories.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
		const limited = memories.slice(0, limit);
		return opSuccess(
			"read_channel",
			limited.length
				? `Read ${limited.length} recent messages across ${sources.length} connectors.`
				: "No recent conversations found.",
			{ sources, memories: limited },
		);
	}

	// Local-room fallback (replaces former read-channel leaf behavior on agent runtime).
	if (!channel) {
		return opFailure(
			"read_channel",
			"INVALID_PARAMETERS",
			"MESSAGE op=read_channel requires a channel parameter (channel name, ID, or room ID), or a connector that supports fetchMessages.",
		);
	}

	const room = await resolveLocalChannelRoom(runtime, source, channel);
	if (!room) {
		return opFailure(
			"read_channel",
			"CHANNEL_NOT_FOUND",
			`Could not find channel "${channel}"${source ? ` on ${source}` : ""}.`,
			{ channel, source },
		);
	}

	try {
		const queryParams: Parameters<IAgentRuntime["getMemories"]>[0] = {
			tableName: "messages",
			roomId: room.id,
			count: limit,
			...(range === "dates"
				? {
						start: parseDateParam(textParam(params.from)),
						end: parseDateParam(
							textParam(params.until) ??
								textParam(params.end) ??
								textParam(params.to),
						),
					}
				: {}),
		} as Parameters<IAgentRuntime["getMemories"]>[0];

		const raw = (await runtime.getMemories(queryParams)) as Memory[];
		const memories = raw.slice(0, limit).reverse();
		return opSuccess(
			"read_channel",
			`Read ${memories.length} messages from ${(room as Room & { name?: string }).name ?? channel}.`,
			{
				channel,
				roomId: room.id,
				messages: memories.map((m, i) => ({
					line: i + 1,
					id: m.id,
					entityId: m.entityId,
					text: m.content?.text,
					createdAt: m.createdAt,
				})),
			},
		);
	} catch (error) {
		return opErrorWrap("read_channel", error);
	}
}

// ---------------------------------------------------------------------------
// op=read_with_contact — person-centric, cross-platform.
//
// Resolves a person via the relationships graph (RelationshipsService /
// graph snapshot) and aggregates their conversations from all rooms the
// person participates in, regardless of platform.
// ---------------------------------------------------------------------------

const READ_WITH_CONTACT_DEFAULT_LIMIT = 15;
const READ_WITH_CONTACT_MAX_LIMIT = 50;

type RelationshipsPersonSummary = {
	primaryEntityId: UUID;
	memberEntityIds: UUID[];
	displayName: string;
	platforms: string[];
	aliases: string[];
};

type RelationshipsGraphSnapshot = {
	people: RelationshipsPersonSummary[];
};

type RelationshipsServiceLike = {
	getGraphSnapshot?: (query?: {
		search?: string | null;
		limit?: number;
	}) => Promise<RelationshipsGraphSnapshot>;
};

function getRelationshipsServiceLike(
	runtime: IAgentRuntime,
): RelationshipsServiceLike | null {
	const candidates: Array<RelationshipsServiceLike | null> = [
		(runtime.getService?.(
			"relationships_graph",
		) as RelationshipsServiceLike | null) ?? null,
		(runtime.getService?.(
			"relationships",
		) as RelationshipsServiceLike | null) ?? null,
	];
	for (const candidate of candidates) {
		if (candidate && typeof candidate.getGraphSnapshot === "function")
			return candidate;
	}
	return null;
}

async function handleReadWithContact(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const contact = textParam(params.contact);
	const entityId = textParam(params.entityId);
	const platform = textParam(params.platform) ?? sourceFromSendAs(message);
	const limit = clampLimit(
		numberParam(params.limit),
		READ_WITH_CONTACT_DEFAULT_LIMIT,
		READ_WITH_CONTACT_MAX_LIMIT,
	);

	if (!contact && !entityId) {
		return opFailure(
			"read_with_contact",
			"INVALID_PARAMETERS",
			"MESSAGE op=read_with_contact requires either contact (person name) or entityId.",
		);
	}

	const relationships = getRelationshipsServiceLike(runtime);
	if (!relationships?.getGraphSnapshot) {
		return opFailure(
			"read_with_contact",
			"SERVICE_NOT_FOUND",
			"RelationshipsService not available — cannot resolve cross-platform conversations.",
		);
	}

	let person: RelationshipsPersonSummary | null = null;
	try {
		const snapshot = await relationships.getGraphSnapshot({
			search: (entityId ?? contact ?? "").trim(),
			limit: 5,
		});
		const candidates = snapshot?.people ?? [];
		if (entityId) {
			person =
				candidates.find(
					(p) =>
						p.primaryEntityId === entityId ||
						p.memberEntityIds.includes(entityId as UUID),
				) ??
				candidates[0] ??
				null;
		} else {
			person = candidates[0] ?? null;
		}
	} catch (error) {
		return opErrorWrap("read_with_contact", error);
	}

	if (!person) {
		return opFailure(
			"read_with_contact",
			"CONTACT_NOT_FOUND",
			`No contacts matching "${contact ?? entityId}" in the relationships graph.`,
		);
	}

	const entityIds = new Set<UUID>();
	entityIds.add(person.primaryEntityId);
	for (const id of person.memberEntityIds) entityIds.add(id);

	const seenRooms = new Set<string>();
	const conversations: Array<{
		platform: string;
		roomId: UUID;
		roomName: string;
		messageCount: number;
		lastMessageAt: string | null;
	}> = [];
	let totalMessages = 0;

	for (const id of entityIds) {
		try {
			const roomIds = await runtime.getRoomsForParticipant(id);
			for (const roomId of roomIds) {
				if (seenRooms.has(roomId)) continue;
				seenRooms.add(roomId);
				const room = await runtime.getRoom(roomId);
				if (!room) continue;
				const roomRecord = room as Room & { name?: string; source?: string };
				const roomPlatform = roomRecord.source ?? room.type ?? "unknown";
				if (platform && roomPlatform.toLowerCase() !== platform.toLowerCase())
					continue;
				const memories = (await runtime.getMemories({
					tableName: "messages",
					roomId: room.id,
					count: limit,
				} as Parameters<IAgentRuntime["getMemories"]>[0])) as Memory[];
				if (memories.length === 0) continue;
				const last = memories[0];
				conversations.push({
					platform: roomPlatform,
					roomId: room.id,
					roomName: roomRecord.name ?? `Room ${room.id.slice(0, 8)}`,
					messageCount: memories.length,
					lastMessageAt: last?.createdAt
						? new Date(last.createdAt).toISOString()
						: null,
				});
				totalMessages += memories.length;
			}
		} catch (error) {
			logger.debug(
				`[MESSAGE/read_with_contact] room scan failed for entity ${id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	conversations.sort((a, b) => {
		if (!a.lastMessageAt && !b.lastMessageAt) return 0;
		if (!a.lastMessageAt) return 1;
		if (!b.lastMessageAt) return -1;
		return b.lastMessageAt.localeCompare(a.lastMessageAt);
	});

	return opSuccess(
		"read_with_contact",
		`Conversations with ${person.displayName}: ${conversations.length} thread(s), ${totalMessages} messages.`,
		{
			personName: person.displayName,
			primaryEntityId: person.primaryEntityId,
			conversations,
			totalMessages,
			platforms: [...new Set(conversations.map((c) => c.platform))],
		},
	);
}

// ---------------------------------------------------------------------------
// op=search — connector passthrough OR semantic conversation search.
// ---------------------------------------------------------------------------

const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 50;
const SEARCH_MATCH_THRESHOLD = 0.6;

const CONVERSATION_SEARCH_CATEGORY: SearchCategoryRegistration = {
	category: "conversations",
	label: "Conversations",
	description:
		"Search stored conversation messages across connected platforms.",
	contexts: ["social_posting", "documents"],
	filters: [
		{
			name: "source",
			label: "Source",
			description: 'Optional platform source, e.g. "discord" or "slack".',
			type: "string",
		},
		{
			name: "entityId",
			label: "Entity ID",
			description: "Optional participant entity ID.",
			type: "string",
		},
	],
	resultSchemaSummary:
		"Message results with line, id, roomId, entityId, text, and createdAt.",
	capabilities: ["semantic", "messages", "cross-platform"],
	source: "core:conversations",
};

function ensureConversationSearchCategory(runtime: IAgentRuntime): void {
	try {
		runtime.getSearchCategory(CONVERSATION_SEARCH_CATEGORY.category, {
			includeDisabled: true,
		});
	} catch {
		runtime.registerSearchCategory(CONVERSATION_SEARCH_CATEGORY);
	}
}

async function handleSearch(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const query =
		textParam(params.query) ??
		textParam(params.searchTerm) ??
		textParam(params.content);
	if (!query)
		return opFailure(
			"search",
			"INVALID_PARAMETERS",
			"MESSAGE op=search requires a query.",
		);
	const limit = clampLimit(
		numberParam(params.limit),
		SEARCH_DEFAULT_LIMIT,
		SEARCH_MAX_LIMIT,
	);
	const source = sourceFromParams(params, message);
	const entityId = textParam(params.entityId);

	// Channel-mode: when a connector source supports searchMessages and the user
	// asked for a connector-scoped search, passthrough.
	const connectors = connectorsWithHook(runtime, "searchMessages");
	if (source && connectors.length > 0) {
		const selection = selectConnectorForOp(
			connectors,
			source,
			message.content?.source,
			"search",
			accountIdFromParams(params, message),
		);
		if ("error" in selection) {
			// fall back to semantic search if explicit source not found
			if (!findConnectorBySource(listMessageConnectors(runtime), source)) {
				return selection.error;
			}
		} else {
			const connector = selection.connector;
			const resolved = await resolveOptionalTarget(
				connector,
				runtime,
				message,
				state,
				params,
				"search",
			);
			if (resolved.error) return resolved.error;
			const context = buildQueryContext(
				runtime,
				message,
				state,
				connector.source,
				resolved.target,
				connector,
			);
			try {
				const searchMessages = connector.searchMessages;
				if (typeof searchMessages !== "function") {
					return opFailure(
						"search",
						"NOT_SUPPORTED",
						`Search is not supported for ${connector.label}.`,
					);
				}
				const memories = (await searchMessages(context, {
					query,
					target: resolved.target,
					limit,
					cursor: textParam(params.cursor),
					before: textParam(params.before),
					after: textParam(params.after),
				})) as Memory[];
				return opSuccess(
					"search",
					`Found ${memories.length} messages on ${connector.label}.`,
					{ source: connector.source, query, memories, mode: "connector" },
				);
			} catch (error) {
				return opErrorWrap("search", error);
			}
		}
	}

	// Conversation-mode: semantic search across stored messages.
	ensureConversationSearchCategory(runtime);
	try {
		const embeddingResult = await runtime.useModel(ModelType.TEXT_EMBEDDING, {
			text: query,
		});
		const embedding = Array.isArray(embeddingResult)
			? embeddingResult
			: (embeddingResult as { embedding?: number[] })?.embedding;
		if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
			return opFailure(
				"search",
				"EMBEDDING_FAILED",
				"Failed to generate search embedding.",
			);
		}

		const searchParams: Parameters<IAgentRuntime["searchMemories"]>[0] = {
			embedding,
			tableName: "messages",
			match_threshold: SEARCH_MATCH_THRESHOLD,
			count: limit + 10,
			...(entityId ? { entityId: entityId as UUID } : {}),
		} as Parameters<IAgentRuntime["searchMemories"]>[0];
		let results = (await runtime.searchMemories(searchParams)) as Memory[];

		// Post-filter by source platform when supplied.
		if (source && results.length > 0) {
			const filtered: Memory[] = [];
			for (const mem of results) {
				try {
					const room = await runtime.getRoom(mem.roomId);
					const roomSource = (
						(room as (Room & { source?: string }) | null)?.source ??
						room?.type ??
						""
					).toLowerCase();
					if (roomSource === source.toLowerCase()) filtered.push(mem);
				} catch {
					// drop rooms we cannot resolve
				}
			}
			results = filtered;
		}

		results = results.filter((m) => m.content?.text).slice(0, limit);
		return opSuccess(
			"search",
			results.length === 0
				? `No conversations matching "${query}".`
				: `Search results for "${query}": ${results.length} messages found.`,
			{
				query,
				source,
				mode: "conversation",
				results: results.map((m, i) => ({
					line: i + 1,
					id: m.id,
					roomId: m.roomId,
					entityId: m.entityId,
					text: m.content?.text,
					createdAt: m.createdAt,
				})),
			},
		);
	} catch (error) {
		return opErrorWrap("search", error);
	}
}

// ---------------------------------------------------------------------------
// op=list_channels / list_servers
// ---------------------------------------------------------------------------

async function handleListChannels(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = connectorsWithHook(runtime, "listRooms");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		message.content?.source,
		"list_channels",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		undefined,
		connector,
	);
	try {
		const listRooms = connector.listRooms;
		if (typeof listRooms !== "function") {
			return opFailure(
				"list_channels",
				"NOT_SUPPORTED",
				`Listing channels is not supported for ${connector.label}.`,
			);
		}
		const targets = await listRooms(context);
		return opSuccess(
			"list_channels",
			`Listed ${targets.length} channels from ${connector.label}.`,
			{
				source: connector.source,
				channels: targets.map((t) => ({
					label: t.label,
					kind: t.kind,
					target: t.target,
				})),
			},
		);
	} catch (error) {
		return opErrorWrap("list_channels", error);
	}
}

async function handleListServers(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const connectors = connectorsWithHook(runtime, "listServers");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		message.content?.source,
		"list_servers",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const context = buildQueryContext(
		runtime,
		message,
		state,
		connector.source,
		undefined,
		connector,
	);
	try {
		const listServers = connector.listServers;
		if (typeof listServers !== "function") {
			return opFailure(
				"list_servers",
				"NOT_SUPPORTED",
				`Listing servers is not supported for ${connector.label}.`,
			);
		}
		const servers = await listServers(context);
		return opSuccess(
			"list_servers",
			`Listed ${servers.length} servers from ${connector.label}.`,
			{
				source: connector.source,
				servers,
			},
		);
	} catch (error) {
		return opErrorWrap("list_servers", error);
	}
}

// ---------------------------------------------------------------------------
// op=join / leave
// ---------------------------------------------------------------------------

async function handleJoinLeave(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: "join" | "leave",
): Promise<ActionResult> {
	const hookName = op === "join" ? "joinHandler" : "leaveHandler";
	const connectors = connectorsWithHook(runtime, hookName);
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		message.content?.source,
		op,
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const resolved = await resolveOptionalTarget(
		connector,
		runtime,
		message,
		state,
		params,
		op,
	);
	if (resolved.error) return resolved.error;
	const payload = {
		roomId: resolved.target?.roomId,
		channelId: resolved.target?.channelId ?? textParam(params.channelId),
		serverId: resolved.target?.serverId ?? textParam(params.serverId),
		alias: textParam(params.alias) ?? textParam(params.channel),
		invite: textParam(params.invite),
		target: resolved.target,
	};
	try {
		if (op === "join") {
			const joinHandler = connector.joinHandler;
			if (typeof joinHandler !== "function") {
				return opFailure(
					"join",
					"NOT_SUPPORTED",
					`Join is not supported for ${connector.label}.`,
				);
			}
			const room = (await joinHandler(runtime, payload)) ?? null;
			return opSuccess("join", `Joined via ${connector.label}.`, {
				source: connector.source,
				room,
			});
		}
		const leaveHandler = connector.leaveHandler;
		if (typeof leaveHandler !== "function") {
			return opFailure(
				"leave",
				"NOT_SUPPORTED",
				`Leave is not supported for ${connector.label}.`,
			);
		}
		await leaveHandler(runtime, payload);
		return opSuccess("leave", `Left via ${connector.label}.`, {
			source: connector.source,
		});
	} catch (error) {
		return opErrorWrap(op, error);
	}
}

// ---------------------------------------------------------------------------
// op=react / edit / delete / pin
// ---------------------------------------------------------------------------

async function handleMessageMutation(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	params: ParamRecord,
	op: "react" | "edit" | "delete" | "pin",
): Promise<ActionResult> {
	const messageId = textParam(params.messageId) ?? textParam(params.id);
	if (!messageId) {
		return opFailure(
			op,
			"INVALID_PARAMETERS",
			`MESSAGE op=${op} requires messageId.`,
		);
	}
	const hookName = (
		{
			react: "reactHandler",
			edit: "editHandler",
			delete: "deleteHandler",
			pin: "pinHandler",
		} as const
	)[op];
	const connectors = connectorsWithHook(runtime, hookName);
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		message.content?.source,
		op,
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	const resolved = await resolveOptionalTarget(
		connector,
		runtime,
		message,
		state,
		params,
		op,
	);
	if (resolved.error) return resolved.error;
	const target = resolved.target ?? {
		source: connector.source,
		accountId: connector.accountId,
	};

	try {
		if (op === "react") {
			const emoji = textParam(params.emoji) ?? textParam(params.reaction);
			if (!emoji)
				return opFailure(
					"react",
					"INVALID_PARAMETERS",
					"MESSAGE op=react requires emoji.",
				);
			const reactHandler = connector.reactHandler;
			if (typeof reactHandler !== "function") {
				return opFailure(
					"react",
					"NOT_SUPPORTED",
					`React is not supported for ${connector.label}.`,
				);
			}
			await reactHandler(runtime, { target, messageId, emoji });
		} else if (op === "edit") {
			const text = textParam(params.text) ?? textParam(params.message);
			if (!text)
				return opFailure(
					"edit",
					"INVALID_PARAMETERS",
					"MESSAGE op=edit requires text.",
				);
			const editHandler = connector.editHandler;
			if (typeof editHandler !== "function") {
				return opFailure(
					"edit",
					"NOT_SUPPORTED",
					`Edit is not supported for ${connector.label}.`,
				);
			}
			const updated = await editHandler(runtime, {
				target,
				messageId,
				content: { text, source: connector.source },
			});
			if (
				updated &&
				typeof updated === "object" &&
				"id" in updated &&
				updated.id
			) {
				await runtime.updateMemory({
					...(updated as Memory),
					id: updated.id as UUID,
				});
			}
		} else if (op === "delete") {
			const deleteHandler = connector.deleteHandler;
			if (typeof deleteHandler !== "function") {
				return opFailure(
					"delete",
					"NOT_SUPPORTED",
					`Delete is not supported for ${connector.label}.`,
				);
			}
			await deleteHandler(runtime, { target, messageId });
		} else {
			const pinHandler = connector.pinHandler;
			if (typeof pinHandler !== "function") {
				return opFailure(
					"pin",
					"NOT_SUPPORTED",
					`Pin is not supported for ${connector.label}.`,
				);
			}
			await pinHandler(runtime, {
				target,
				messageId,
				pin: boolParam(params.pin) ?? true,
			});
		}
		return opSuccess(op, `MESSAGE op=${op} completed via ${connector.label}.`, {
			source: connector.source,
			messageId,
			target,
		});
	} catch (error) {
		return opErrorWrap(op, error);
	}
}

// ---------------------------------------------------------------------------
// op=get_user
// ---------------------------------------------------------------------------

async function handleGetUser(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	params: ParamRecord,
): Promise<ActionResult> {
	const userId = textParam(params.userId) ?? textParam(params.entityId);
	const username = textParam(params.username);
	const handle = textParam(params.handle) ?? textParam(params.target);
	if (!userId && !username && !handle) {
		return opFailure(
			"get_user",
			"INVALID_PARAMETERS",
			"MESSAGE op=get_user requires userId, username, handle, or target.",
		);
	}
	const connectors = connectorsWithHook(runtime, "getUser");
	const selection = selectConnectorForOp(
		connectors,
		sourceFromParams(params, message),
		message.content?.source,
		"get_user",
		accountIdFromParams(params, message),
	);
	if ("error" in selection) return selection.error;
	const connector = selection.connector;
	try {
		const getUserFn = connector.getUser;
		if (typeof getUserFn !== "function") {
			return opFailure(
				"get_user",
				"NOT_SUPPORTED",
				`User lookup is not supported for ${connector.label}.`,
			);
		}
		const user = await getUserFn(runtime, {
			userId,
			username,
			handle,
		});
		return opSuccess(
			"get_user",
			user
				? `Found user on ${connector.label}.`
				: `No user found on ${connector.label}.`,
			{ source: connector.source, user },
		);
	} catch (error) {
		return opErrorWrap("get_user", error);
	}
}

// ---------------------------------------------------------------------------
// Triage / inbox / draft delegations
// ---------------------------------------------------------------------------

const TRIAGE_OP_TO_ACTION: Record<
	Extract<
		MessageOperation,
		| "triage"
		| "list_inbox"
		| "search_inbox"
		| "draft_reply"
		| "draft_followup"
		| "respond"
		| "send_draft"
		| "schedule_draft_send"
		| "manage"
	>,
	Action
> = {
	triage: triageMessagesAction,
	list_inbox: listInboxAction,
	search_inbox: searchInboxMessagesAction,
	draft_reply: draftReplyAction,
	draft_followup: draftFollowupAction,
	respond: respondToMessageAction,
	send_draft: sendDraftAction,
	schedule_draft_send: scheduleDraftSendAction,
	manage: manageMessageAction,
};

async function delegateToTriage(
	op: keyof typeof TRIAGE_OP_TO_ACTION,
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	options: HandlerOptions | undefined,
	callback: Parameters<Action["handler"]>[4],
	responses: Parameters<Action["handler"]>[5],
): Promise<ActionResult> {
	const action = TRIAGE_OP_TO_ACTION[op];
	const result = await runWithActionRoutingContext(
		{ actionName: action.name, modelClass: action.modelClass },
		() => action.handler(runtime, message, state, options, callback, responses),
	);
	const normalized: ActionResult = result ?? {
		success: true,
		text: `MESSAGE operation=${op} completed.`,
	};
	return {
		...normalized,
		data: {
			...(normalized.data ?? {}),
			actionName: "MESSAGE",
			operation: op,
			subAction: op,
		},
	};
}

// ---------------------------------------------------------------------------
// Parameters (single declarative schema)
// ---------------------------------------------------------------------------

export const MESSAGE_PARAMETERS: ActionParameter[] = [
	{
		name: "action",
		description: `Message action. One of: ${MESSAGE_OPS.join(", ")}.`,
		required: false,
		schema: { type: "string", enum: [...MESSAGE_OPS] },
	},
	{
		name: "source",
		description:
			"Connector source such as discord, slack, signal, whatsapp, telegram, x, imessage, matrix, line, google-chat, feishu, instagram, wechat, gmail.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "accountId",
		description:
			"Optional connector account id for multi-account message connectors.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "sources",
		description:
			"Optional inbox sources for op=triage, list_inbox, or search_inbox.",
		required: false,
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "folder",
		description:
			"Optional inbox folder hint for triage, list_inbox, search_inbox, draft, or respond operations.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "target",
		description:
			"Loose target reference: user, handle, channel, room, group, server, contact, phone, email, or platform-specific ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "targetKind",
		description:
			"Target kind for op=send: user, contact, channel, room, thread, group, server, email, or phone.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "channel",
		description:
			"Channel/room/group reference for read_channel, list_channels, join, leave.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "roomId",
		description: "Platform room or stored room ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "channelId",
		description: "Platform channel ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "server",
		description: "Loose server, guild, workspace, or team name/reference.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "serverId",
		description: "Platform server, guild, workspace, or team ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "userId",
		description: "Platform user ID or stored entity ID.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "username",
		description: "Loose username for get_user.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "handle",
		description: "Loose platform handle for get_user.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "contact",
		description: "Person name (relationships graph) for op=read_with_contact.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "entityId",
		description:
			"Person/entity ID for read_with_contact, get_user, or scoped search.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "platform",
		description: "Optional platform filter for read_with_contact or search.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "threadId",
		description: "Thread identifier for threaded operations.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "thread",
		description: "Optional thread parent reference for op=send.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "alias",
		description: "Channel/room alias for op=join or op=leave.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "invite",
		description: "Invite URL or token for op=join.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "message",
		description: "Message text for op=send or replacement text for op=edit.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "text",
		description: "Replacement text for op=edit (alias of message).",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "query",
		description: "Search term for op=search or op=search_inbox.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "content",
		description:
			"Inbox search text or message lookup hint for triage/draft/respond.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "sender",
		description: "Sender identifier for inbox search or reply lookup.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "body",
		description:
			"Draft or response body for draft_reply, draft_followup, respond.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "reply",
		description: "Alias for body when drafting or responding to a message.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "replyText",
		description: "Alias for body when drafting or responding to a message.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "messageBody",
		description: "Alias for body when drafting or responding to a message.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "to",
		description: "Recipient identifiers for op=draft_followup.",
		required: false,
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "subject",
		description: "Subject for email-like draft operations.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "draftId",
		description:
			"Draft identifier for op=send_draft or op=schedule_draft_send.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "confirmed",
		description:
			"Whether the user explicitly confirmed sending for op=send_draft.",
		required: false,
		schema: { type: "boolean" },
	},
	{
		name: "sendAt",
		description: "Scheduled send time for op=schedule_draft_send.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "messageId",
		description:
			"Platform/full message ID or stored memory ID for react/edit/delete/pin/respond.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "inReplyToId",
		description:
			"Alias for messageId when drafting or responding to a message.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "id",
		description: "Alias for messageId, accepted for planner compatibility.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "emoji",
		description: "Reaction value for op=react.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "pin",
		description: "Pin state for op=pin (false to unpin when supported).",
		required: false,
		schema: { type: "boolean" },
	},
	{
		name: "manageOperation",
		description:
			"Management operation for op=manage: archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, unsubscribe.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "label",
		description: "Label for op=manage when adding/removing labels.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "tag",
		description: "Tag for op=manage when adding/removing tags.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "attachments",
		description: "Optional attachments for op=send.",
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
		description: "Urgency for op=send: normal, important, urgent.",
		required: false,
		schema: { type: "string", enum: ["normal", "important", "urgent"] },
	},
	{
		name: "persist",
		description:
			"Whether op=send persists outbound content to target room memory. Defaults true.",
		required: false,
		schema: { type: "boolean" },
	},
	{
		name: "limit",
		description: "Maximum number of items to return.",
		required: false,
		schema: { type: "number" },
	},
	{
		name: "range",
		description: 'For op=read_channel: "recent" (default) or "dates".',
		required: false,
		schema: { type: "string", enum: ["recent", "dates"] },
	},
	{
		name: "from",
		description: "Start date/timestamp for op=read_channel range=dates.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "worldIds",
		description: "Optional account/server scopes for inbox operations.",
		required: false,
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "channelIds",
		description: "Optional channel/conversation scopes for inbox operations.",
		required: false,
		schema: { type: "array", items: { type: "string" } },
	},
	{
		name: "sinceMs",
		description: "Start timestamp (ms) for inbox list/search/triage.",
		required: false,
		schema: { type: "number" },
	},
	{
		name: "since",
		description: "Start date for op=search_inbox.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "until",
		description:
			"End date/timestamp for op=read_channel range=dates or op=search_inbox.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "cursor",
		description: "Opaque pagination cursor.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "before",
		description: "Older boundary for read/search results.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "after",
		description: "Newer boundary for read/search results.",
		required: false,
		schema: { type: "string" },
	},
];

// ---------------------------------------------------------------------------
// Action surface
// ---------------------------------------------------------------------------

const spec = getActionSpec("MESSAGE");

function refreshDescriptions(action: Action, runtime: IAgentRuntime): void {
	refreshMessageConnectorActionDescription(action, runtime, {
		baseDescription: MESSAGE_DESCRIPTION,
		baseCompressed: MESSAGE_COMPRESSED,
	});
}

export const messageAction: Action = {
	name: "MESSAGE",
	similes: [
		"DM",
		"DIRECT_MESSAGE",
		"CHAT",
		"CHANNEL",
		"ROOM",
		// PRD action-catalog aliases. These resolve to MESSAGE subactions via
		// handler argument routing; see packages/docs/action-prd-map.md.
		"INBOX_LIST_UNREAD",
		"INBOX_TRIAGE_PRIORITY",
		"INBOX_SUMMARIZE_CHANNEL",
		"MESSAGE_DRAFT_REPLY",
		"MESSAGE_SEND_APPROVAL_REQUEST",
		"MESSAGE_SEND_CONFIRMED",
		"MESSAGE_ARCHIVE_OR_DEFER",
		"MESSAGE_REPAIR_AFTER_MISS",
		"FOLLOWUP_CREATE_DRAFT",
		"FOLLOWUP_SEND_CONFIRMED",
	],
	tags: [
		"domain:messages",
		"capability:read",
		"capability:write",
		"capability:update",
		"capability:delete",
		"capability:send",
		"capability:schedule",
		"surface:remote-api",
		"risk:irreversible",
	],
	description: MESSAGE_DESCRIPTION,
	descriptionCompressed: MESSAGE_COMPRESSED,
	contexts: MESSAGE_CONTEXTS,
	roleGate: { minRole: "ADMIN" },
	parameters: MESSAGE_PARAMETERS,
	examples: (spec?.examples ?? []) as ActionExample[][],
	validate: async (runtime, message, state) => {
		refreshDescriptions(messageAction, runtime);
		return hasActionContext(message, state, {
			contexts: MESSAGE_CONTEXTS,
			keywords: [
				"message",
				"dm",
				"direct message",
				"send",
				"read messages",
				"read channel",
				"search messages",
				"search conversations",
				"messages with",
				"chat with",
				"conversation with",
				"list channels",
				"list servers",
				"react",
				"edit message",
				"delete message",
				"pin message",
				"join channel",
				"leave channel",
				"user info",
				"inbox",
				"email",
				"gmail",
				"triage",
				"draft reply",
				"send draft",
				"schedule send",
				"respond to message",
				"archive message",
				"unsubscribe",
			],
		});
	},
	handler: async (runtime, message, state, options, callback, responses) => {
		refreshDescriptions(messageAction, runtime);
		const params = paramsFromOptions(options);
		const op = inferOp(message, params);
		const lifeOpsHook = (
			runtime as IAgentRuntime & {
				lifeOpsMessageActionHook?: {
					handleMessageAction?: (args: {
						operation: MessageOperation;
						runtime: IAgentRuntime;
						message: Memory;
						state?: State;
						options?: HandlerOptions;
						callback?: HandlerCallback;
						responses?: Memory[];
					}) => Promise<ActionResult | null | undefined>;
				};
			}
		).lifeOpsMessageActionHook;
		const lifeOpsResult = await lifeOpsHook?.handleMessageAction?.({
			operation: op,
			runtime,
			message,
			state,
			options,
			callback,
			responses,
		});
		if (lifeOpsResult) {
			return lifeOpsResult;
		}

		switch (op) {
			case "send":
				return handleSend(runtime, message, state, params);
			case "read_channel":
				return handleReadChannel(runtime, message, state, params);
			case "read_with_contact":
				return handleReadWithContact(runtime, message, state, params);
			case "search":
				return handleSearch(runtime, message, state, params);
			case "list_channels":
				return handleListChannels(runtime, message, state, params);
			case "list_servers":
				return handleListServers(runtime, message, state, params);
			case "join":
			case "leave":
				return handleJoinLeave(runtime, message, state, params, op);
			case "react":
			case "edit":
			case "delete":
			case "pin":
				return handleMessageMutation(runtime, message, state, params, op);
			case "get_user":
				return handleGetUser(runtime, message, state, params);
			case "triage":
			case "list_inbox":
			case "search_inbox":
			case "draft_reply":
			case "draft_followup":
			case "respond":
			case "send_draft":
			case "schedule_draft_send":
			case "manage":
				return delegateToTriage(
					op,
					runtime,
					message,
					state,
					options,
					callback,
					responses,
				);
			default: {
				const unreachable: never = op;
				return invalidOpResult(
					unreachable as MessageOperation,
					`MESSAGE received unknown operation "${String(unreachable)}".`,
				);
			}
		}
	},
};

export default messageAction;
