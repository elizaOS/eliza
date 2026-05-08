import type {
	Action,
	ActionExample,
	ActionParameter,
	ActionResult,
	Content,
	ContentValue,
	HandlerOptions,
	IAgentRuntime,
	Media,
	Memory,
	PostConnector,
	State,
	UUID,
} from "../../../types/index.ts";
import { ChannelType } from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { stringToUuid } from "../../../utils.ts";
import {
	boolParam,
	buildPostQueryContext,
	explicitTargetFromParams,
	getPostConnectorsWithHook,
	limitParam,
	PAGINATION_PARAMETERS,
	type ParamRecord,
	paramsFromOptions,
	refreshPostConnectorActionDescription,
	selectConnector,
	sourceParam,
	textParam,
} from "./connectorActionUtils.ts";

const POST_OPS = ["send", "read", "search"] as const;
type PostOp = (typeof POST_OPS)[number];

const POST_CONTEXTS = ["social_posting", "connectors"];

const POST_DESCRIPTION =
	"Primary action for public feed surfaces and timelines. Use op to choose the subaction: send publishes a post, read fetches recent feed posts, search searches public posts. Addressed DMs, groups, channels, and rooms belong to MESSAGE.";
const POST_COMPRESSED =
	"primary post action ops send read search public feed timeline posts";

function normalizeOp(value: unknown): PostOp | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[-\s]+/g, "_");
	if (POST_OPS.includes(normalized as PostOp)) return normalized as PostOp;
	if (normalized === "publish" || normalized === "post") return "send";
	if (normalized === "read_feed" || normalized === "read_posts") return "read";
	if (normalized === "search_feed" || normalized === "search_posts") {
		return "search";
	}
	return undefined;
}

function resolveOp(message: Memory, options?: HandlerOptions): PostOp {
	const params = paramsFromOptions(options);
	const explicit =
		normalizeOp(params.op) ??
		normalizeOp(params.operation) ??
		normalizeOp(params.action);
	if (explicit) return explicit;
	const text = `${message.content?.text ?? ""}`.toLowerCase();
	if (params.query || /\b(search|find)\b/.test(text)) return "search";
	if (params.feed || /\b(read|recent|timeline|feed)\b/.test(text))
		return "read";
	return "send";
}

function failure(
	op: PostOp | "unknown",
	error: string,
	text: string,
	extra: Record<string, unknown> = {},
): ActionResult {
	return {
		success: false,
		text,
		values: { success: false, error },
		data: { actionName: "POST", op, error, ...extra },
	};
}

function normalizeAttachments(value: unknown): Media[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const attachments = value
		.filter(
			(item): item is Record<string, unknown> =>
				typeof item === "object" && item !== null && !Array.isArray(item),
		)
		.map((item) => {
			const url = textParam(item.url);
			if (!url) return null;
			return {
				...item,
				id: textParam(item.id) ?? url,
				url,
			} as Media;
		})
		.filter((item): item is Media => item !== null);
	return attachments.length > 0 ? attachments : undefined;
}

function postText(params: ParamRecord, message: Memory): string {
	return (
		textParam(params.text) ??
		textParam(params.message) ??
		textParam(params.post) ??
		textParam(message.content?.text) ??
		""
	);
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

function accountIdParam(
	params: ParamRecord,
	message: Memory,
): string | undefined {
	const metadata = recordValue(message.content?.metadata);
	const sendAs = connectorSendAsMetadata(message);
	return (
		textParam(params.accountId) ??
		textParam(params.connectorAccountId) ??
		textParam(sendAs?.accountId) ??
		textParam(metadata?.accountId)
	);
}

function sourceParamForMessage(
	params: ParamRecord,
	message: Memory,
): string | undefined {
	const sendAs = connectorSendAsMetadata(message);
	return sourceParam(params) ?? textParam(sendAs?.source);
}

function buildPostContent(
	params: ParamRecord,
	connector: PostConnector,
	message: Memory,
): Content {
	const feed = textParam(params.feed);
	const target = textParam(params.target) ?? textParam(message.content?.target);
	const messageMediaId = message.content?.mediaId;
	const mediaId =
		textParam(params.mediaId) ??
		(typeof messageMediaId === "number"
			? String(messageMediaId)
			: textParam(messageMediaId));
	const replyTo = textParam(params.replyTo) ?? textParam(params.inReplyTo);
	const accountId = connector.accountId ?? accountIdParam(params, message);
	const connectorAccount = connector.account
		? (JSON.parse(JSON.stringify(connector.account)) as ContentValue)
		: undefined;
	const content: Content = {
		text: postText(params, message),
		source: connector.source,
		channelType: ChannelType.FEED,
		metadata: {
			feed,
			target,
			mediaId,
			replyTo,
			accountId,
			connectorAccount,
		},
	};
	if (replyTo && /^[0-9a-f-]{36}$/i.test(replyTo)) {
		content.inReplyTo = replyTo as UUID;
	}
	const attachments = normalizeAttachments(params.attachments);
	if (attachments) content.attachments = attachments;
	return content;
}

function applyPostContentShaping(
	connector: PostConnector,
	content: Content,
): Content {
	let text = typeof content.text === "string" ? content.text : "";
	const shaping = connector.contentShaping;
	if (text && typeof shaping?.postProcess === "function") {
		text = shaping.postProcess(text);
	}
	const maxLength = shaping?.constraints?.maxLength;
	if (
		text &&
		typeof maxLength === "number" &&
		Number.isFinite(maxLength) &&
		maxLength > 0 &&
		text.length > maxLength
	) {
		text = text.slice(0, Math.max(0, Math.floor(maxLength)));
	}
	return text === content.text ? content : { ...content, text };
}

async function ensurePostRoom(
	runtime: IAgentRuntime,
	source: string,
): Promise<{ roomId: UUID; worldId: UUID }> {
	const worldId = stringToUuid(
		`${runtime.agentId}:${source}:feed-world`,
	) as UUID;
	const roomId = stringToUuid(`${runtime.agentId}:${source}:feed-room`) as UUID;
	await runtime.ensureWorldExists({
		id: worldId,
		name: `${source} feed`,
		agentId: runtime.agentId,
		metadata: { source, type: "post_feed" },
	});
	await runtime.ensureRoomExists({
		id: roomId,
		name: `${source} feed`,
		source,
		type: ChannelType.FEED,
		worldId,
		channelId: `${source}:feed`,
		metadata: { source, type: "post_feed" },
	});
	await runtime.ensureParticipantInRoom(runtime.agentId, roomId);
	return { roomId, worldId };
}

async function persistPostMemory(
	runtime: IAgentRuntime,
	connector: PostConnector,
	content: Content,
	sentMemory: Memory | undefined,
	persist: boolean,
): Promise<Memory | undefined> {
	if (!persist) return sentMemory;
	const { roomId, worldId } = await ensurePostRoom(runtime, connector.source);
	const memory: Memory = {
		...(sentMemory ?? {}),
		id:
			sentMemory?.id ??
			(stringToUuid(
				`${runtime.agentId}:${connector.source}:post:${Date.now()}:${content.text ?? ""}`,
			) as UUID),
		entityId: sentMemory?.entityId ?? runtime.agentId,
		agentId: sentMemory?.agentId ?? runtime.agentId,
		roomId: sentMemory?.roomId ?? roomId,
		worldId: sentMemory?.worldId ?? worldId,
		content: {
			...content,
			...(sentMemory?.content ?? {}),
			source: connector.source,
			channelType: ChannelType.FEED,
		},
		metadata: {
			type: "message",
			source: connector.source,
			provider: connector.source,
			...(sentMemory?.metadata ?? {}),
		},
		createdAt: sentMemory?.createdAt ?? Date.now(),
	};
	try {
		if (memory.id) {
			await runtime.upsertMemory(memory, "messages");
			return memory;
		}
		const id = await runtime.createMemory(memory, "messages");
		return { ...memory, id };
	} catch (error) {
		runtime.logger.warn(
			{
				src: "POST:send",
				err: error instanceof Error ? error.message : String(error),
				source: connector.source,
			},
			"Post sent but target feed memory persistence failed",
		);
		return memory;
	}
}

async function persistChatActionMemory(params: {
	runtime: IAgentRuntime;
	message: Memory;
	connector: PostConnector;
	targetMemory?: Memory;
	platformMessageId?: string;
}): Promise<Memory | undefined> {
	const { runtime, message, connector, targetMemory, platformMessageId } =
		params;
	try {
		const memoryId = stringToUuid(
			[
				message.id ?? message.roomId,
				"POST",
				connector.source,
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
				text: `Posted to ${connector.label}.`,
				actions: ["POST"],
				source: "agent_action",
				type: "action_result",
				actionName: "POST",
				actionStatus: "completed",
				responseMessageId: targetMemory?.id,
				metadata: {
					op: "send",
					targetSource: connector.source,
					targetLabel: connector.label,
					targetRoomId: targetMemory?.roomId,
					sentMessageId: platformMessageId,
				},
			},
			metadata: {
				type: "message",
				source: "agent_action",
				provider: connector.source,
				actionName: "POST",
				op: "send",
				targetSource: connector.source,
				targetLabel: connector.label,
				targetRoomId: targetMemory?.roomId,
				sentMessageId: platformMessageId,
			} as Memory["metadata"],
			createdAt: Date.now(),
		};
		await runtime.upsertMemory(memory, "messages");
		return memory;
	} catch (error) {
		runtime.logger.warn(
			{
				src: "POST:send",
				err: error instanceof Error ? error.message : String(error),
				source: connector.source,
			},
			"Post sent but current chat action memory persistence failed",
		);
		return undefined;
	}
}

async function handleSend(
	runtime: IAgentRuntime,
	message: Memory,
	options?: HandlerOptions,
): Promise<ActionResult> {
	const params = paramsFromOptions(options);
	const connectors = getPostConnectorsWithHook(runtime, "postHandler");
	const selected = selectConnector(
		"POST",
		connectors,
		sourceParamForMessage(params, message),
		message.content?.source,
		accountIdParam(params, message),
	);
	if ("result" in selected) return selected.result;
	const content = applyPostContentShaping(
		selected.connector,
		buildPostContent(params, selected.connector, message),
	);
	if (!textParam(content.text) && !content.attachments?.length) {
		return failure(
			"send",
			"POST_SEND_FAILED",
			"POST op=send requires non-empty text or attachments.",
		);
	}
	const postHandler = selected.connector.postHandler;
	if (!postHandler) {
		return failure(
			"send",
			"POST_SEND_FAILED",
			`${selected.connector.source} no longer supports POST op=send.`,
			{ source: selected.connector.source },
		);
	}
	const sentMemory = (await postHandler(runtime, content)) as
		| Memory
		| undefined;
	const persisted = await persistPostMemory(
		runtime,
		selected.connector,
		content,
		sentMemory,
		boolParam(params.persist) !== false,
	);
	const platformMessageId =
		typeof persisted?.metadata === "object"
			? (persisted.metadata as { messageIdFull?: string }).messageIdFull
			: undefined;
	await persistChatActionMemory({
		runtime,
		message,
		connector: selected.connector,
		targetMemory: persisted,
		platformMessageId,
	});
	return {
		success: true,
		text: `Posted to ${selected.connector.label}.`,
		values: { success: true, source: selected.connector.source },
		data: {
			actionName: "POST",
			op: "send",
			source: selected.connector.source,
			accountId: selected.connector.accountId,
			memoryId: persisted?.id,
			responseMessageId: platformMessageId,
		},
	};
}

async function handleRead(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	options?: HandlerOptions,
): Promise<ActionResult> {
	const params = paramsFromOptions(options);
	const connectors = getPostConnectorsWithHook(runtime, "fetchFeed");
	const selected = selectConnector(
		"POST",
		connectors,
		sourceParamForMessage(params, message),
		message.content?.source,
		accountIdParam(params, message),
	);
	if ("result" in selected) return selected.result;
	const fetchFeed = selected.connector.fetchFeed;
	if (!fetchFeed) {
		return failure(
			"read",
			"POST_READ_FAILED",
			`${selected.connector.source} no longer supports POST op=read.`,
			{ source: selected.connector.source },
		);
	}
	const context = {
		...buildPostQueryContext(
			runtime,
			message,
			state,
			selected.connector.source,
		),
		accountId: selected.connector.accountId,
		account: selected.connector.account,
	};
	const target = explicitTargetFromParams(
		selected.connector.source,
		params,
	).target;
	if (target && selected.connector.accountId)
		target.accountId = selected.connector.accountId;
	const posts = await fetchFeed(context, {
		feed: textParam(params.feed),
		target,
		limit: limitParam(params),
		cursor: textParam(params.cursor),
		before: textParam(params.before),
		after: textParam(params.after),
	});
	return {
		success: true,
		text: `Read ${posts.length} posts from ${selected.connector.label}.`,
		values: { success: true, source: selected.connector.source },
		data: {
			actionName: "POST",
			op: "read",
			posts,
			source: selected.connector.source,
		},
	};
}

async function handleSearch(
	runtime: IAgentRuntime,
	message: Memory,
	state: State | undefined,
	options?: HandlerOptions,
): Promise<ActionResult> {
	const params = paramsFromOptions(options);
	const query = textParam(params.query) ?? textParam(params.searchTerm);
	if (!query) {
		return failure(
			"search",
			"POST_SEARCH_FAILED",
			"POST op=search requires a query.",
		);
	}
	const connectors = getPostConnectorsWithHook(runtime, "searchPosts");
	const selected = selectConnector(
		"POST",
		connectors,
		sourceParamForMessage(params, message),
		message.content?.source,
		accountIdParam(params, message),
	);
	if ("result" in selected) return selected.result;
	const searchPosts = selected.connector.searchPosts;
	if (!searchPosts) {
		return failure(
			"search",
			"POST_SEARCH_FAILED",
			`${selected.connector.source} no longer supports POST op=search.`,
			{ source: selected.connector.source },
		);
	}
	const context = {
		...buildPostQueryContext(
			runtime,
			message,
			state,
			selected.connector.source,
		),
		accountId: selected.connector.accountId,
		account: selected.connector.account,
	};
	const posts = await searchPosts(context, {
		query,
		limit: limitParam(params),
		cursor: textParam(params.cursor),
		before: textParam(params.before),
		after: textParam(params.after),
	});
	return {
		success: true,
		text: `Found ${posts.length} posts on ${selected.connector.label}.`,
		values: { success: true, source: selected.connector.source, query },
		data: {
			actionName: "POST",
			op: "search",
			query,
			posts,
			source: selected.connector.source,
		},
	};
}

function refreshDescriptions(action: Action, runtime: IAgentRuntime): void {
	refreshPostConnectorActionDescription(action, runtime, {
		baseDescription: POST_DESCRIPTION,
		baseCompressed: POST_COMPRESSED,
		hook: "postHandler",
	});
}

export const POST_PARAMETERS: ActionParameter[] = [
	{
		name: "op",
		description: "Post subaction: send, read, or search.",
		required: false,
		schema: { type: "string", enum: [...POST_OPS] },
	},
	{
		name: "source",
		description:
			"Post connector source such as x, bluesky, farcaster, nostr, or instagram.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "accountId",
		description:
			"Optional connector account id for multi-account post connectors.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "text",
		description: "Public post text for op=send.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "target",
		description:
			"Loose feed target for op=send/read, such as a user, channel, media id, or connector-specific reference.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "feed",
		description:
			"Feed convention for op=read, such as home, user, hashtag, channel, or connector-specific feed.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "replyTo",
		description:
			"Optional post, cast, media, or thread identifier when publishing a reply/comment.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "mediaId",
		description:
			"Optional media identifier for connectors that publish comments or replies to media.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "query",
		description: "Search term for op=search.",
		required: false,
		schema: { type: "string" },
	},
	{
		name: "attachments",
		description:
			"Optional media attachments for connectors that support media posts.",
		required: false,
		schema: { type: "array" },
	},
	{
		name: "persist",
		description:
			"Whether to persist a sent post into the target feed memory. Defaults true. op=send only.",
		required: false,
		schema: { type: "boolean" },
	},
	...PAGINATION_PARAMETERS,
];

export const postAction: Action = {
	name: "POST",
	similes: ["TWEET", "CAST", "PUBLISH", "FEED_POST", "TIMELINE"],
	description: POST_DESCRIPTION,
	descriptionCompressed: POST_COMPRESSED,
	contexts: POST_CONTEXTS,
	roleGate: { minRole: "ADMIN" },
	validate: async (runtime, message, state) => {
		refreshDescriptions(postAction, runtime);
		return hasActionContextOrKeyword(message, state, {
			contexts: POST_CONTEXTS,
			keywords: [
				"post",
				"tweet",
				"cast",
				"publish",
				"feed",
				"timeline",
				"search posts",
				"read feed",
			],
		});
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<ActionResult> => {
		refreshDescriptions(postAction, runtime);
		const op = resolveOp(message, options);
		switch (op) {
			case "send":
				return handleSend(runtime, message, options);
			case "read":
				return handleRead(runtime, message, state, options);
			case "search":
				return handleSearch(runtime, message, state, options);
			default:
				return failure(
					"unknown",
					"POST_INVALID",
					`POST op must be one of: ${POST_OPS.join(", ")}.`,
				);
		}
	},
	parameters: POST_PARAMETERS,
	examples: [] as ActionExample[][],
};

export default postAction;
