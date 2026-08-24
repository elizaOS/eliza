/**
 * Deterministic tests for the destructive-action confirmation protocol.
 * The mocked runtime exercises pending state, expiry, cancellation, cache cleanup,
 * multilingual confirmation, and rejection of model-supplied authorization flags.
 */
import { describe, expect, it, vi } from "vitest";
import type { Memory } from "../types/memory.js";
import type { IAgentRuntime } from "../types/runtime.js";
import {
	clearPendingConfirmation,
	gateDestructiveConfirmation,
	llmConfirmedFlagIsAuthoritative,
	requireConfirmation,
} from "./confirmation.js";

function createMockRuntime() {
	const cacheStore = new Map<string, unknown>();
	return {
		getCache: vi.fn(async <T>(key: string): Promise<T | undefined> => {
			return cacheStore.get(key) as T | undefined;
		}),
		setCache: vi.fn(async (key: string, value: unknown): Promise<boolean> => {
			cacheStore.set(key, value);
			return true;
		}),
		deleteCache: vi.fn(async (key: string): Promise<boolean> => {
			return cacheStore.delete(key);
		}),
		cacheStore,
	} as unknown as IAgentRuntime & { cacheStore: Map<string, unknown> };
}

describe("confirmation utilities", () => {
	it("stashes pending confirmation and invokes callback on first call", async () => {
		const runtime = createMockRuntime();
		const callback = vi.fn();
		const message: Memory = {
			entityId: "user-123",
			content: { text: "delete my account", source: "discord" },
		} as unknown as Memory;

		const decision = await requireConfirmation({
			runtime,
			message,
			actionName: "DELETE_ACCOUNT",
			pendingKey: "account:user-123",
			prompt: "Are you sure you want to delete your account?",
			callback,
			metadata: { userId: "user-123" },
		});

		expect(decision.status).toBe("pending");
		expect(callback).toHaveBeenCalledWith({
			text: "Are you sure you want to delete your account?",
			source: "discord",
		});
		expect(runtime.cacheStore.size).toBe(1);
	});

	it("confirms on affirmative user reply across languages", async () => {
		const affirmativeReplies = [
			"yes",
			"yeah",
			"y",
			"sure",
			"proceed",
			"do it",
			"oui",
			"sí",
			"はい",
			"确认",
			"확인",
		];

		for (const reply of affirmativeReplies) {
			const runtime = createMockRuntime();
			const message1: Memory = {
				entityId: "user-123",
				content: { text: "delete item 1" },
			} as unknown as Memory;

			await requireConfirmation({
				runtime,
				message: message1,
				actionName: "DELETE_ITEM",
				pendingKey: "item:1",
				prompt: "Delete item 1?",
				metadata: { itemId: 1 },
			});

			const message2: Memory = {
				entityId: "user-123",
				content: { text: reply },
			} as unknown as Memory;

			const decision = await requireConfirmation({
				runtime,
				message: message2,
				actionName: "DELETE_ITEM",
				pendingKey: "item:1",
				prompt: "Delete item 1?",
			});

			expect(decision.status).toBe("confirmed");
			expect(decision.metadata).toEqual({ itemId: 1 });
			expect(runtime.cacheStore.size).toBe(0);
		}
	});

	it("cancels when user replies with non-affirmative text", async () => {
		const runtime = createMockRuntime();
		const message1: Memory = {
			entityId: "user-123",
			content: { text: "delete item 1" },
		} as unknown as Memory;

		await requireConfirmation({
			runtime,
			message: message1,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item 1?",
			metadata: { itemId: 1 },
		});

		const message2: Memory = {
			entityId: "user-123",
			content: { text: "no, cancel that" },
		} as unknown as Memory;

		const decision = await requireConfirmation({
			runtime,
			message: message2,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item 1?",
		});

		expect(decision.status).toBe("cancelled");
		expect(decision.metadata).toEqual({ itemId: 1 });
		expect(runtime.cacheStore.size).toBe(0);
	});

	it("treats expired pending confirmation as fresh call", async () => {
		const runtime = createMockRuntime();
		const message1: Memory = {
			entityId: "user-123",
			content: { text: "delete item" },
		} as unknown as Memory;

		await requireConfirmation({
			runtime,
			message: message1,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item?",
			ttlMs: 10,
		});

		const cachedKey = "confirmation:user-123:DELETE_ITEM:item:1";
		const record = runtime.cacheStore.get(cachedKey) as { createdAt: number };
		record.createdAt = Date.now() - 50;

		const message2: Memory = {
			entityId: "user-123",
			content: { text: "yes" },
		} as unknown as Memory;

		const decision = await requireConfirmation({
			runtime,
			message: message2,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item?",
			ttlMs: 10,
		});

		expect(decision.status).toBe("pending");
	});

	it("clears pending confirmation via clearPendingConfirmation", async () => {
		const runtime = createMockRuntime();
		const message: Memory = {
			entityId: "user-123",
			content: { text: "delete" },
		} as unknown as Memory;

		await requireConfirmation({
			runtime,
			message,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item?",
		});

		expect(runtime.cacheStore.size).toBe(1);

		await clearPendingConfirmation({
			runtime,
			userId: "user-123",
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
		});

		expect(runtime.cacheStore.size).toBe(0);
	});

	it("delegates properly through gateDestructiveConfirmation across all statuses", async () => {
		const runtime = createMockRuntime();
		const message: Memory = {
			entityId: "user-123",
			content: { text: "remove" },
		} as unknown as Memory;

		const pendingGate = await gateDestructiveConfirmation({
			runtime,
			message,
			actionName: "REMOVE_ENTRY",
			pendingKey: "entry:5",
			prompt: "Remove entry 5?",
			metadata: { entryId: 5 },
		});

		expect(pendingGate.status).toBe("pending");

		// Confirmed branch
		const confirmMessage: Memory = {
			entityId: "user-123",
			content: { text: "yes" },
		} as unknown as Memory;

		const confirmedGate = await gateDestructiveConfirmation({
			runtime,
			message: confirmMessage,
			actionName: "REMOVE_ENTRY",
			pendingKey: "entry:5",
			prompt: "Remove entry 5?",
		});

		expect(confirmedGate.status).toBe("confirmed");
		expect(confirmedGate.metadata).toEqual({ entryId: 5 });

		// Cancelled branch
		await gateDestructiveConfirmation({
			runtime,
			message,
			actionName: "REMOVE_ENTRY",
			pendingKey: "entry:6",
			prompt: "Remove entry 6?",
			metadata: { entryId: 6 },
		});

		const cancelMessage: Memory = {
			entityId: "user-123",
			content: { text: "no" },
		} as unknown as Memory;

		const cancelledGate = await gateDestructiveConfirmation({
			runtime,
			message: cancelMessage,
			actionName: "REMOVE_ENTRY",
			pendingKey: "entry:6",
			prompt: "Remove entry 6?",
		});

		expect(cancelledGate.status).toBe("cancelled");
		expect(cancelledGate.metadata).toEqual({ entryId: 6 });
	});

	it("supports custom confirmRegex pattern", async () => {
		const runtime = createMockRuntime();
		const message1: Memory = {
			entityId: "user-123",
			content: { text: "delete database" },
		} as unknown as Memory;

		const customRegex = /^PROCEED_WITH_PURGE$/;

		await requireConfirmation({
			runtime,
			message: message1,
			actionName: "PURGE_DB",
			pendingKey: "db:production",
			prompt: "Type PROCEED_WITH_PURGE to confirm",
			confirmRegex: customRegex,
		});

		// Replying with standard "yes" is cancelled under customRegex
		const regularYes: Memory = {
			entityId: "user-123",
			content: { text: "yes" },
		} as unknown as Memory;

		const decision1 = await requireConfirmation({
			runtime,
			message: regularYes,
			actionName: "PURGE_DB",
			pendingKey: "db:production",
			prompt: "Type PROCEED_WITH_PURGE to confirm",
			confirmRegex: customRegex,
		});
		expect(decision1.status).toBe("cancelled");

		// Request again and reply with exact pattern
		await requireConfirmation({
			runtime,
			message: message1,
			actionName: "PURGE_DB",
			pendingKey: "db:production",
			prompt: "Type PROCEED_WITH_PURGE to confirm",
			confirmRegex: customRegex,
		});

		const matchingReply: Memory = {
			entityId: "user-123",
			content: { text: "PROCEED_WITH_PURGE" },
		} as unknown as Memory;

		const decision2 = await requireConfirmation({
			runtime,
			message: matchingReply,
			actionName: "PURGE_DB",
			pendingKey: "db:production",
			prompt: "Type PROCEED_WITH_PURGE to confirm",
			confirmRegex: customRegex,
		});
		expect(decision2.status).toBe("confirmed");
	});

	it("falls back to DEFAULT_TTL_MS when non-positive ttlMs is supplied", async () => {
		const runtime = createMockRuntime();
		const message: Memory = {
			entityId: "user-123",
			content: { text: "delete item" },
		} as unknown as Memory;

		await requireConfirmation({
			runtime,
			message,
			actionName: "DELETE_ITEM",
			pendingKey: "item:1",
			prompt: "Delete item?",
			ttlMs: -100,
		});

		const cachedKey = "confirmation:user-123:DELETE_ITEM:item:1";
		const record = runtime.cacheStore.get(cachedKey) as { ttlMs: number };
		expect(record.ttlMs).toBe(300_000);
	});

	it("rejects LLM confirmed flag as authoritative", () => {
		expect(llmConfirmedFlagIsAuthoritative(true)).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative("true")).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative(1)).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative({})).toBe(false);
	});
});
