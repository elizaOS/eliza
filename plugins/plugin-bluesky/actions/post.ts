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
	validate: async (
		_runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<boolean> => true,

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
	},
};
