/**
 * Unit tests for `MessageManager` URL enrichment plus the in-flight
 * task-agent/timeout-suppression guards, with a mocked runtime and stubbed
 * document-URL fetch.
 */
import {
	__setDocumentUrlFetchImplForTests,
	ContentType,
	type IAgentRuntime,
	ServiceType,
} from "@elizaos/core";
import type { Message as DiscordMessage } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginDiscordOutboundDelivery,
	createDiscordMessageMemoryOnce,
	hasActiveTaskAgentWorkForMessage,
	MessageManager,
	shouldSuppressTimeoutForInFlightDispatchForTests,
} from "../messages";

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
	} as IAgentRuntime;
}

function discordMessage(content: string): DiscordMessage {
	return {
		content,
		embeds: [],
		mentions: { users: new Map() },
		attachments: new Map(),
	} as DiscordMessage;
}

function managerFor(testRuntime: IAgentRuntime): MessageManager {
	const manager = Object.create(MessageManager.prototype) as MessageManager;
	Object.assign(
		manager as {
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
	__setDocumentUrlFetchImplForTests(null);
});

describe("MessageManager URL enrichment", () => {
	it("turns direct webpage URLs into readable link attachments without a browser service", async () => {
		const html =
			"<html><head><style>.hidden{display:none}</style><script>window.secret='wrong'</script></head><body><p>secret phrase: velvet-lantern-7419</p></body></html>";
		__setDocumentUrlFetchImplForTests(async () => {
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
		__setDocumentUrlFetchImplForTests(async () => {
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
		} as IAgentRuntime;
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

describe("shouldSuppressTimeoutForInFlightDispatchForTests", () => {
	it("suppresses only timeout handling that loses to an in-flight response dispatch", () => {
		expect(
			shouldSuppressTimeoutForInFlightDispatchForTests({
				generationTimedOut: true,
				responseDispatchInFlight: true,
			}),
		).toBe(true);

		expect(
			shouldSuppressTimeoutForInFlightDispatchForTests({
				generationTimedOut: false,
				responseDispatchInFlight: true,
			}),
		).toBe(false);

		expect(
			shouldSuppressTimeoutForInFlightDispatchForTests({
				generationTimedOut: true,
				responseDispatchInFlight: false,
			}),
		).toBe(false);
	});
});

describe("createDiscordMessageMemoryOnce", () => {
	const message = {
		id: "22222222-2222-4222-8222-222222222222",
		entityId: "11111111-1111-1111-1111-111111111111",
		agentId: "11111111-1111-1111-1111-111111111111",
		roomId: "33333333-3333-4333-8333-333333333333",
		content: { text: "already sent", source: "discord" },
	} as Memory;

	it("skips connector-side persistence when the deterministic memory id already exists", async () => {
		const existing = { ...message, content: { text: "persisted" } };
		const createMemory = vi.fn();
		const testRuntime = {
			agentId: message.agentId,
			createMemory,
			getMemoryById: vi.fn(async () => existing),
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as unknown as IAgentRuntime;

		const result = await createDiscordMessageMemoryOnce(testRuntime, message, {
			operation: "test",
			platformMessageId: "discord-message-1",
		});

		expect(result).toBe(existing);
		expect(createMemory).not.toHaveBeenCalled();
		expect(testRuntime.logger.debug).toHaveBeenCalledWith(
			expect.objectContaining({
				messageId: "discord-message-1",
				memoryId: message.id,
				operation: "test",
			}),
			"Skipping duplicate Discord message memory",
		);
	});

	it("creates the message memory when no existing id is found", async () => {
		const createMemory = vi.fn(async () => message.id);
		const testRuntime = {
			agentId: message.agentId,
			createMemory,
			getMemoryById: vi.fn(async () => null),
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as unknown as IAgentRuntime;

		const result = await createDiscordMessageMemoryOnce(testRuntime, message, {
			operation: "test",
		});

		expect(result).toBe(message);
		expect(createMemory).toHaveBeenCalledWith(message, "messages");
	});
});

describe("beginDiscordOutboundDelivery dedupe window", () => {
	it("suppresses the same committed logical send inside the window and frees it on release", () => {
		const state = new Map<string, number>();
		const base = {
			channelId: "123",
			text: "The answer is 42.",
			now: 1_000,
			windowMs: 5_000,
			state,
		};

		const first = beginDiscordOutboundDelivery(base);
		expect(first.kind).toBe("deliver");
		if (first.kind !== "deliver") throw new Error("unreachable");
		first.reservation.commit();

		// Same account/channel/text inside the window → duplicate (this is the
		// callback-vs-connector-send double-delivery guard).
		expect(beginDiscordOutboundDelivery({ ...base, now: 3_000 }).kind).toBe(
			"duplicate",
		);

		// A different channel is a different logical send.
		expect(
			beginDiscordOutboundDelivery({ ...base, channelId: "456", now: 3_000 })
				.kind,
		).toBe("deliver");

		// Past the window the reservation has expired and delivery is allowed.
		expect(beginDiscordOutboundDelivery({ ...base, now: 7_000 }).kind).toBe(
			"deliver",
		);
	});

	it("released (failed) sends do not block a retry, and empty payloads bypass dedupe", () => {
		const state = new Map<string, number>();
		const params = {
			channelId: "123",
			text: "retry me",
			now: 1_000,
			windowMs: 5_000,
			state,
		};

		const first = beginDiscordOutboundDelivery(params);
		if (first.kind !== "deliver") throw new Error("expected deliver");
		// The REST send failed; releasing must let the retry through instead of
		// eating it as a duplicate of the failed attempt.
		first.reservation.release();
		expect(beginDiscordOutboundDelivery({ ...params, now: 1_100 }).kind).toBe(
			"deliver",
		);

		// No text and no attachments → nothing to dedupe on; always deliver.
		expect(
			beginDiscordOutboundDelivery({ channelId: "123", now: 1_000, state })
				.kind,
		).toBe("deliver");
	});
});
