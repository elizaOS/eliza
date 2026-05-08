import {
	ChannelType,
	type Content,
	composePrompt,
	createUniqueUuid,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type UUID,
} from "@elizaos/core";
import type { BlueSkyClient } from "../client";
import {
	generatePostTemplate,
	truncatePostTemplate,
} from "../generated/prompts/typescript/prompts.js";
import type { BlueSkyPost, CreatePostRequest } from "../types";
import { BLUESKY_MAX_POST_LENGTH } from "../types";
import {
	normalizeBlueSkyAccountId,
	readBlueSkyAccountId,
} from "../utils/config";

interface PostConnectorQueryContext {
	runtime: IAgentRuntime;
	roomId?: UUID;
	source?: string;
	accountId?: string;
	target?: { entityId?: UUID | string; channelId?: string; threadId?: string };
	metadata?: Record<string, unknown>;
}

function clampLimit(
	value: number | undefined,
	fallback: number,
	max: number,
): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(Math.max(1, Math.floor(value as number)), max);
}

function readContentString(
	content: Content,
	keys: string[],
): string | undefined {
	const record = content as Content & Record<string, unknown>;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

export class BlueSkyPostService {
	static serviceType = "IPostService";

	constructor(
		private readonly client: BlueSkyClient,
		private readonly runtime: IAgentRuntime,
		public readonly accountId: string = "default",
	) {}

	getAccountId(): string {
		return normalizeBlueSkyAccountId(this.accountId);
	}

	async getPosts(limit = 50, cursor?: string): Promise<BlueSkyPost[]> {
		const response = await this.client.getTimeline({ limit, cursor });
		return response.feed.map((item) => item.post);
	}

	async createPost(
		text: string,
		replyTo?: { uri: string; cid: string },
	): Promise<BlueSkyPost> {
		let postText = text.trim() || (await this.generateContent());

		if (postText.length > BLUESKY_MAX_POST_LENGTH) {
			postText = await this.truncate(postText);
		}

		const request: CreatePostRequest = {
			content: { text: postText },
			replyTo,
		};

		return this.client.sendPost(request);
	}

	async handleSendPost(
		runtime: IAgentRuntime,
		content: Content,
	): Promise<Memory> {
		const requestedAccountId = normalizeBlueSkyAccountId(
			readBlueSkyAccountId(content) ?? this.getAccountId(),
		);
		if (requestedAccountId !== this.getAccountId()) {
			throw new Error(
				`BlueSky account '${requestedAccountId}' is not available in this service instance`,
			);
		}

		const replyUri = readContentString(content, ["replyToUri", "replyTo"]);
		const replyCid = readContentString(content, ["replyToCid"]);
		const post = await this.createPost(
			content.text ?? "",
			replyUri && replyCid ? { uri: replyUri, cid: replyCid } : undefined,
		);
		return this.postToMemory(runtime, post);
	}

	async fetchFeed(
		context: PostConnectorQueryContext,
		params: {
			feed?: string;
			target?: PostConnectorQueryContext["target"];
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<Memory[]> {
		const requestedAccountId = normalizeBlueSkyAccountId(
			context.accountId ?? context.metadata?.accountId ?? this.getAccountId(),
		);
		if (requestedAccountId !== this.getAccountId()) {
			throw new Error(
				`BlueSky account '${requestedAccountId}' is not available in this service instance`,
			);
		}

		const response = await this.client.getTimeline({
			limit: clampLimit(params.limit, 25, 100),
			cursor: params.cursor,
		});
		return response.feed.map((item) =>
			this.postToMemory(context.runtime, item.post),
		);
	}

	async searchPosts(
		context: PostConnectorQueryContext,
		params: { query: string; limit?: number; cursor?: string },
	): Promise<Memory[]> {
		const requestedAccountId = normalizeBlueSkyAccountId(
			context.accountId ?? context.metadata?.accountId ?? this.getAccountId(),
		);
		if (requestedAccountId !== this.getAccountId()) {
			throw new Error(
				`BlueSky account '${requestedAccountId}' is not available in this service instance`,
			);
		}

		const query = params.query?.trim();
		if (!query) {
			throw new Error("BlueSky searchPosts connector requires a query.");
		}
		const response = await this.client.searchPosts({
			query,
			limit: clampLimit(params.limit, 25, 100),
			cursor: params.cursor,
		});
		return response.posts.map((post) =>
			this.postToMemory(context.runtime, post),
		);
	}

	async deletePost(uri: string): Promise<void> {
		await this.client.deletePost(uri);
	}

	private postToMemory(runtime: IAgentRuntime, post: BlueSkyPost): Memory {
		const createdAt =
			Date.parse(post.indexedAt || post.record.createdAt) || Date.now();
		const authorId = post.author.did || post.author.handle || "unknown";
		const entityId =
			authorId === runtime.agentId
				? runtime.agentId
				: createUniqueUuid(runtime, `bluesky:user:${authorId}`);
		const roomId = createUniqueUuid(runtime, `bluesky:feed:${authorId}`);

		return {
			id: createUniqueUuid(runtime, `bluesky:post:${post.uri}`),
			agentId: runtime.agentId,
			entityId,
			roomId,
			createdAt,
			content: {
				text: post.record.text,
				source: "bluesky",
				url: `https://bsky.app/profile/${post.author.handle}/post/${post.uri.split("/").pop()}`,
				channelType: ChannelType.FEED,
			},
			metadata: {
				type: "message",
				source: "bluesky",
				accountId: this.getAccountId(),
				provider: "bluesky",
				timestamp: createdAt,
				fromBot: entityId === runtime.agentId,
				messageIdFull: post.uri,
				chatType: ChannelType.FEED,
				sender: {
					id: authorId,
					name: post.author.displayName,
					username: post.author.handle,
				},
				bluesky: {
					accountId: this.getAccountId(),
					uri: post.uri,
					cid: post.cid,
					authorDid: post.author.did,
					authorHandle: post.author.handle,
					replyCount: post.replyCount,
					repostCount: post.repostCount,
					likeCount: post.likeCount,
					quoteCount: post.quoteCount,
				},
			} as unknown as Memory["metadata"],
		};
	}

	private async generateContent(): Promise<string> {
		const prompt = composePrompt({
			state: {
				maxLength: String(BLUESKY_MAX_POST_LENGTH),
			},
			template: generatePostTemplate,
		});
		const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 100,
		});
		return response as string;
	}

	private async truncate(text: string): Promise<string> {
		const prompt = composePrompt({
			state: {
				maxLength: String(BLUESKY_MAX_POST_LENGTH),
				text,
			},
			template: truncatePostTemplate,
		});
		const response = await this.runtime.useModel(ModelType.TEXT_SMALL, {
			prompt,
			maxTokens: 100,
		});
		const truncated = response as string;
		return truncated.length > BLUESKY_MAX_POST_LENGTH
			? `${truncated.substring(0, BLUESKY_MAX_POST_LENGTH - 3)}...`
			: truncated;
	}
}
