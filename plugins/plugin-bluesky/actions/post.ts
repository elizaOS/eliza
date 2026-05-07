/**
 * POST_BLUESKY action: post a top-level Bluesky post or a reply.
 *
 * Wraps BlueSkyPostService.createPost (which delegates content generation to
 * BlueSkyPostService.generateContent → runtime.useModel). Anchors that useModel
 * call so it is reachable from the action surface.
 */

import type {
	Action,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { BlueSkyService } from "../services/bluesky";
import { BLUESKY_SERVICE_NAME } from "../types";

interface ReplyTo {
	uri: string;
	cid: string;
}

const BLUESKY_CONTEXTS = ["social_posting", "connectors"] as const;
const BLUESKY_KEYWORDS = [
	"bluesky",
	"bsky",
	"post",
	"reply",
	"skeet",
	"social",
	"publicar",
	"responder",
	"répondre",
	"publier",
	"antworten",
	"beitrag",
	"pubblicare",
	"rispondere",
	"投稿",
	"返信",
	"发布",
	"回复",
	"게시",
	"답장",
] as const;

function readParam(
	options: HandlerOptions | Record<string, unknown> | undefined,
	key: string,
): unknown {
	const maybeOptions = options as { parameters?: Record<string, unknown> };
	if (maybeOptions?.parameters && key in maybeOptions.parameters) {
		return maybeOptions.parameters[key];
	}
	return (options as Record<string, unknown> | undefined)?.[key];
}

function readStringParam(
	options: HandlerOptions | Record<string, unknown> | undefined,
	key: string,
): string {
	const value = readParam(options, key);
	return typeof value === "string" ? value : "";
}

function readReplyTo(
	options: HandlerOptions | Record<string, unknown> | undefined,
): ReplyTo | undefined {
	const raw = readParam(options, "replyTo");
	if (!raw || typeof raw !== "object") return undefined;
	const candidate = raw as { uri?: unknown; cid?: unknown };
	if (
		typeof candidate.uri !== "string" ||
		typeof candidate.cid !== "string" ||
		!candidate.uri ||
		!candidate.cid
	) {
		return undefined;
	}
	return { uri: candidate.uri, cid: candidate.cid };
}

function hasSelectedContext(state: State | undefined): boolean {
	const selected = new Set<string>();
	const collect = (value: unknown) => {
		if (!Array.isArray(value)) return;
		for (const item of value) {
			if (typeof item === "string") selected.add(item);
		}
	};
	collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
	collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
	const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
		| { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
		| undefined;
	collect(contextObject?.trajectoryPrefix?.selectedContexts);
	collect(contextObject?.metadata?.selectedContexts);
	return BLUESKY_CONTEXTS.some((context) => selected.has(context));
}

function hasBlueskyIntent(message: Memory, state: State | undefined): boolean {
	const text = [
		typeof message.content?.text === "string" ? message.content.text : "",
		typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
	]
		.join("\n")
		.toLowerCase();
	return BLUESKY_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

export const postBlueskyAction: Action = {
	name: "POST_BLUESKY",
	similes: [
		"BLUESKY_POST",
		"BLUESKY_REPLY",
		"REPLY_BLUESKY",
		"POST_TO_BLUESKY",
	],
	description:
		"Post a top-level Bluesky post or a reply. kind=post supports replyTo={uri,cid}. text optional; if empty the runtime model generates content.",
	descriptionCompressed: "Post or reply on Bluesky.",
	contexts: [...BLUESKY_CONTEXTS],
	contextGate: { anyOf: [...BLUESKY_CONTEXTS] },
	roleGate: { minRole: "USER" },
	parameters: [
		{
			name: "kind",
			description: "Always 'post' for now.",
			required: true,
			schema: { type: "string" },
		},
		{
			name: "text",
			description:
				"Post text. If empty, the agent's model generates content.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "replyTo",
			description:
				"Reply target as { uri, cid }. Omit for a top-level post.",
			required: false,
			schema: { type: "object" },
		},
	],
	validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
		const service = runtime.getService<BlueSkyService>(BLUESKY_SERVICE_NAME);
		if (!service) return false;
		return hasSelectedContext(state) || hasBlueskyIntent(message, state);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const kindRaw = readStringParam(options, "kind").toLowerCase();
		const kind = kindRaw || "post";
		if (kind !== "post") {
			const text = "Provide kind: post.";
			if (callback) await callback({ text, actions: ["POST_BLUESKY"] });
			return { success: false, error: "invalid_kind" };
		}

		const service = runtime.getService<BlueSkyService>(BLUESKY_SERVICE_NAME);
		if (!service) {
			if (callback) {
				await callback({ text: "Bluesky service is not running" });
			}
			return { success: false, error: "service_unavailable" };
		}

		const postService = service.getPostService(runtime.agentId);
		if (!postService) {
			if (callback) {
				await callback({ text: "Bluesky post service is not initialized" });
			}
			return { success: false, error: "post_service_unavailable" };
		}

		const text = readStringParam(options, "text");
		const replyTo = readReplyTo(options);

		logger.info(
			{
				src: "plugin:bluesky",
				op: "POST_BLUESKY",
				hasText: text.trim().length > 0,
				hasReply: Boolean(replyTo),
			},
			"Posting to Bluesky",
		);
		try {
			const post = await postService.createPost(text, replyTo);
			logger.info(
				{
					src: "plugin:bluesky",
					op: "POST_BLUESKY",
					uri: post.uri,
					cid: post.cid,
				},
				"Bluesky post created",
			);

			const summary = replyTo
				? `Replied on Bluesky: ${post.uri}`
				: `Posted to Bluesky: ${post.uri}`;
			if (callback) {
				await callback({
					text: summary,
					actions: ["POST_BLUESKY"],
					data: { uri: post.uri, cid: post.cid },
				});
			}

			return {
				success: true,
				text: summary,
				data: { uri: post.uri, cid: post.cid, replyTo: replyTo ?? null },
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(
				{ src: "plugin:bluesky", op: "POST_BLUESKY", error: message },
				"Failed to post to Bluesky",
			);
			if (callback) {
				await callback({ text: `Failed to post to Bluesky: ${message}` });
			}
			return { success: false, error: message };
		}
	},
};
