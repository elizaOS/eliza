import {
	__setKnowledgeUrlFetchImplForTests,
	ContentType,
	type IAgentRuntime,
	ServiceType,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasActiveTaskAgentWorkForMessage, MessageManager } from "../messages";

function runtime(): IAgentRuntime {
	return {
		agentId: "11111111-1111-1111-1111-111111111111",
		getService: vi.fn((serviceType) =>
			serviceType === ServiceType.VIDEO ? null : null,
		),
		logger: {
			debug: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

function discordMessage(content: string): DiscordMessage {
	return {
		content,
		embeds: [],
		mentions: { users: new Map() },
		attachments: new Map(),
	} as unknown as DiscordMessage;
}

function managerFor(testRuntime: IAgentRuntime): MessageManager {
	const manager = Object.create(MessageManager.prototype) as MessageManager;
	Object.assign(
		manager as unknown as {
			runtime: IAgentRuntime;
			attachmentManager: {
				processAttachments: () => Promise<[]>;
			};
		},
		{
			runtime: testRuntime,
			attachmentManager: {
				processAttachments: vi.fn(async () => []),
			},
		},
	);
	return manager;
}

afterEach(() => {
	__setKnowledgeUrlFetchImplForTests(null);
});

describe("MessageManager URL enrichment", () => {
	it("turns direct webpage URLs into readable link attachments without a browser service", async () => {
		const html =
			"<html><head><style>.hidden{display:none}</style><script>window.secret='wrong'</script></head><body><p>secret phrase: velvet-lantern-7419</p></body></html>";
		__setKnowledgeUrlFetchImplForTests(async () => {
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		});

		const result = await managerFor(runtime()).processMessage(
			discordMessage(
				"fetch http://203.0.113.10/proof and reply with the secret phrase",
			),
		);

		expect(result.attachments).toHaveLength(1);
		expect(result.attachments[0]).toMatchObject({
			id: expect.stringMatching(/^webpage-[a-f0-9]{24}$/),
			url: "http://203.0.113.10/proof",
			source: "Web",
			contentType: ContentType.LINK,
			text: "secret phrase: velvet-lantern-7419",
		});
	});

	it("uses a stable attachment id for the same direct URL", async () => {
		__setKnowledgeUrlFetchImplForTests(async () => {
			return new Response("same page", {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		});

		const manager = managerFor(runtime());
		const first = await manager.processMessage(
			discordMessage("read http://203.0.113.10/repeated"),
		);
		const second = await manager.processMessage(
			discordMessage("read http://203.0.113.10/repeated"),
		);

		expect(first.attachments[0]?.id).toBe(second.attachments[0]?.id);
	});
});

describe("hasActiveTaskAgentWorkForMessage", () => {
	function runtimeWithTasks(tasks: Map<string, unknown>): IAgentRuntime {
		return {
			getService: vi.fn((serviceType) =>
				serviceType === "SWARM_COORDINATOR" ? { tasks } : null,
			),
		} as unknown as IAgentRuntime;
	}

	it("matches active task-agent work by originating message id", () => {
		const runtime = runtimeWithTasks(
			new Map([
				[
					"session-1",
					{
						status: "tool_running",
						originMetadata: { messageId: "message-memory-id" },
					},
				],
			]),
		);

		expect(hasActiveTaskAgentWorkForMessage(runtime, "message-memory-id")).toBe(
			true,
		);
	});

	it("matches queued active task-agent work by originating message id", () => {
		const runtime = runtimeWithTasks(
			new Map([
				[
					"session-1",
					{
						status: "active",
						originMetadata: { messageId: "message-memory-id" },
					},
				],
			]),
		);

		expect(hasActiveTaskAgentWorkForMessage(runtime, "message-memory-id")).toBe(
			true,
		);
	});

	it("matches blocked task-agent work by originating message id", () => {
		const runtime = runtimeWithTasks(
			new Map([
				[
					"session-1",
					{
						status: "blocked",
						originMetadata: { messageId: "message-memory-id" },
					},
				],
			]),
		);

		expect(hasActiveTaskAgentWorkForMessage(runtime, "message-memory-id")).toBe(
			true,
		);
	});

	it("ignores active task-agent work for a different originating message id", () => {
		const runtime = runtimeWithTasks(
			new Map([
				[
					"session-1",
					{
						status: "tool_running",
						originMetadata: { messageId: "other-message-memory-id" },
					},
				],
			]),
		);

		expect(hasActiveTaskAgentWorkForMessage(runtime, "message-memory-id")).toBe(
			false,
		);
	});

	it("ignores terminal task-agent work", () => {
		const runtime = runtimeWithTasks(
			new Map([
				[
					"session-1",
					{
						status: "completed",
						originMetadata: { messageId: "message-memory-id" },
					},
				],
			]),
		);

		expect(hasActiveTaskAgentWorkForMessage(runtime, "message-memory-id")).toBe(
			false,
		);
	});
});
