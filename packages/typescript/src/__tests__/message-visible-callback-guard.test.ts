import { describe, expect, it, vi } from "vitest";
import { wrapSingleTurnVisibleCallback } from "../services/message.ts";
import type { IAgentRuntime, Memory } from "../types";
import { stringToUuid } from "../utils";

function buildCallbackMemory(): Memory {
	return {
		id: stringToUuid("callback-memory"),
		agentId: stringToUuid("agent-1"),
		entityId: stringToUuid("user-1"),
		roomId: stringToUuid("room-1"),
		content: { text: "stored" },
	};
}

describe("wrapSingleTurnVisibleCallback", () => {
	it("delivers every visible reply in a single turn", async () => {
		const callback = vi.fn(async () => [buildCallbackMemory()]);
		const runtime = {
			agentId: stringToUuid("agent-1"),
			logger: {
				warn: vi.fn(),
			},
		} as Pick<IAgentRuntime, "agentId" | "logger">;
		const guardedCallback = wrapSingleTurnVisibleCallback(
			runtime,
			{
				id: stringToUuid("message-1"),
				roomId: stringToUuid("room-1"),
			},
			callback,
		);

		expect(guardedCallback).toBeDefined();
		await guardedCallback?.({ text: "first visible reply" }, "INBOX");
		await guardedCallback?.({ text: "second visible reply" }, "CALL_USER");

		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback).toHaveBeenCalledWith(
			{ text: "first visible reply" },
			"INBOX",
		);
		expect(callback).toHaveBeenCalledWith(
			{ text: "second visible reply" },
			"CALL_USER",
		);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("delivers exact duplicate attachment callbacks", async () => {
		const callback = vi.fn(async () => [buildCallbackMemory()]);
		const runtime = {
			agentId: stringToUuid("agent-1"),
			logger: {
				warn: vi.fn(),
			},
		} as Pick<IAgentRuntime, "agentId" | "logger">;
		const guardedCallback = wrapSingleTurnVisibleCallback(
			runtime,
			{
				id: stringToUuid("message-2"),
				roomId: stringToUuid("room-1"),
			},
			callback,
		);
		const content = {
			attachments: [
				{
					url: "https://example.com/file.pdf",
					title: "file.pdf",
					contentType: "application/pdf",
				},
			],
		};

		await guardedCallback?.(content, "LIFEOPS_COMPUTER_USE");
		await guardedCallback?.(content, "LIFEOPS_COMPUTER_USE");

		expect(callback).toHaveBeenCalledTimes(2);
		expect(callback).toHaveBeenNthCalledWith(
			1,
			content,
			"LIFEOPS_COMPUTER_USE",
		);
		expect(callback).toHaveBeenNthCalledWith(
			2,
			content,
			"LIFEOPS_COMPUTER_USE",
		);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});

	it("still forwards non-visible callbacks after a visible reply", async () => {
		const callback = vi.fn(async () => [buildCallbackMemory()]);
		const runtime = {
			agentId: stringToUuid("agent-1"),
			logger: {
				warn: vi.fn(),
			},
		} as Pick<IAgentRuntime, "agentId" | "logger">;
		const guardedCallback = wrapSingleTurnVisibleCallback(
			runtime,
			{
				id: stringToUuid("message-3"),
				roomId: stringToUuid("room-1"),
			},
			callback,
		);

		await guardedCallback?.({ text: "visible reply" }, "INBOX");
		await guardedCallback?.({ thought: "internal progress only" }, "INBOX");

		expect(callback).toHaveBeenCalledTimes(2);
		expect(runtime.logger.warn).not.toHaveBeenCalled();
	});
});
