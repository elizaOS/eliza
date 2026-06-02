import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BlueSkyMessageService } from "../services/message";
import { BlueSkyPostService } from "../services/post";
import type {
	BlueSkyConversation,
	BlueSkyMessage,
	BlueSkyPost,
} from "../types";
import { BlueskyWorkflowCredentialProvider } from "../workflow-credential-provider";

function runtime(settings: Record<string, string | null> = {}): IAgentRuntime {
	return {
		agentId: "agent-1",
		character: { settings: {} },
		getSetting: vi.fn((key: string) => settings[key] ?? null),
		getRoom: vi.fn(),
		useModel: vi.fn(),
	} as unknown as IAgentRuntime;
}

function message(overrides: Partial<BlueSkyMessage> = {}): BlueSkyMessage {
	return {
		id: "msg-1",
		rev: "rev-1",
		text: "hello",
		sender: { did: "did:example:alice" },
		sentAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

function conversation(
	overrides: Partial<BlueSkyConversation> = {},
): BlueSkyConversation {
	return {
		id: "convo-1",
		rev: "rev-1",
		members: [
			{ did: "did:example:self", handle: "self.example.com" },
			{
				did: "did:example:alice",
				handle: "alice.example.com",
				displayName: "Alice",
			},
		],
		unreadCount: 0,
		muted: false,
		...overrides,
	};
}

function post(overrides: Partial<BlueSkyPost> = {}): BlueSkyPost {
	return {
		uri: "at://did:example:alice/app.bsky.feed.post/post-1",
		cid: "cid-1",
		author: {
			did: "did:example:alice",
			handle: "alice.example.com",
			displayName: "Alice",
		},
		record: {
			$type: "app.bsky.feed.post",
			text: "hello feed",
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		indexedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("BlueSky connector services", () => {
	it("rejects empty DM content before calling the client", async () => {
		const client = { sendMessage: vi.fn() };
		const service = new BlueSkyMessageService(
			client as never,
			runtime(),
			"default",
		);

		await expect(
			service.handleSendMessage(
				runtime(),
				{ channelId: "convo-1" },
				{ text: " " },
			),
		).rejects.toThrow("non-empty text");
		expect(client.sendMessage).not.toHaveBeenCalled();
	});

	it("rejects DM sends to another configured account", async () => {
		const client = { sendMessage: vi.fn() };
		const service = new BlueSkyMessageService(
			client as never,
			runtime(),
			"default",
		);

		await expect(
			service.handleSendMessage(
				runtime(),
				{ channelId: "convo-1", accountId: "support" },
				{ text: "hello" },
			),
		).rejects.toThrow("support");
		expect(client.sendMessage).not.toHaveBeenCalled();
	});

	it("fetches recent DM messages from all conversations when no target is provided", async () => {
		const client = {
			getConversations: vi.fn(async () => ({
				conversations: [
					conversation({ id: "older" }),
					conversation({ id: "newer" }),
				],
			})),
			getMessages: vi.fn(async (convoId: string) => ({
				messages: [
					message({
						id: `msg-${convoId}`,
						sentAt:
							convoId === "newer"
								? "2026-01-02T00:00:00.000Z"
								: "2026-01-01T00:00:00.000Z",
					}),
				],
			})),
		};
		const service = new BlueSkyMessageService(
			client as never,
			runtime(),
			"default",
		);

		const memories = await service.fetchConnectorMessages({
			runtime: runtime(),
			accountId: "default",
		});

		expect(client.getConversations).toHaveBeenCalledWith(25);
		expect(client.getMessages).toHaveBeenCalledWith("older", 1);
		expect(client.getMessages).toHaveBeenCalledWith("newer", 1);
		expect(memories.map((memory) => memory.metadata?.messageIdFull)).toEqual([
			"msg-newer",
			"msg-older",
		]);
	});

	it("requires a non-empty BlueSky post search query", async () => {
		const client = { searchPosts: vi.fn() };
		const service = new BlueSkyPostService(
			client as never,
			runtime(),
			"default",
		);

		await expect(
			service.searchPosts(
				{ runtime: runtime(), accountId: "default" },
				{ query: " " },
			),
		).rejects.toThrow("requires a query");
		expect(client.searchPosts).not.toHaveBeenCalled();
	});

	it("clamps feed fetch limits before querying BlueSky", async () => {
		const client = {
			getTimeline: vi.fn(async () => ({
				feed: [{ post: post() }],
			})),
		};
		const service = new BlueSkyPostService(
			client as never,
			runtime(),
			"default",
		);

		const memories = await service.fetchFeed(
			{ runtime: runtime(), accountId: "default" },
			{ limit: 10_000, cursor: "cursor-1" },
		);

		expect(client.getTimeline).toHaveBeenCalledWith({
			limit: 100,
			cursor: "cursor-1",
		});
		expect(memories[0]?.metadata?.accountId).toBe("default");
	});

	it("rejects post operations for a different account before querying BlueSky", async () => {
		const client = { getTimeline: vi.fn() };
		const service = new BlueSkyPostService(
			client as never,
			runtime(),
			"default",
		);

		await expect(
			service.fetchFeed({ runtime: runtime(), accountId: "support" }),
		).rejects.toThrow("support");
		expect(client.getTimeline).not.toHaveBeenCalled();
	});
});

describe("BlueskyWorkflowCredentialProvider", () => {
	it("returns trimmed workflow credentials for supported auth type", async () => {
		const provider = new BlueskyWorkflowCredentialProvider(
			runtime({
				BLUESKY_HANDLE: " agent.example.com ",
				BLUESKY_PASSWORD: " app-password ",
			}),
		);

		await expect(provider.resolve("user-1", "httpHeaderAuth")).resolves.toEqual(
			{
				status: "credential_data",
				data: {
					name: "X-Bluesky-Handle",
					value: "agent.example.com",
					appPassword: "app-password",
				},
			},
		);
	});

	it("returns null for unsupported or incomplete workflow credentials", async () => {
		const provider = new BlueskyWorkflowCredentialProvider(
			runtime({
				BLUESKY_HANDLE: "agent.example.com",
				BLUESKY_PASSWORD: " ",
			}),
		);

		await expect(provider.resolve("user-1", "apiKeyAuth")).resolves.toBeNull();
		await expect(
			provider.resolve("user-1", "httpHeaderAuth"),
		).resolves.toBeNull();
		expect(
			provider.checkCredentialTypes(["httpHeaderAuth", "apiKeyAuth"]),
		).toEqual({
			supported: ["httpHeaderAuth"],
			unsupported: ["apiKeyAuth"],
		});
	});
});
