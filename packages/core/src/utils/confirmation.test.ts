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

	it("delegates properly through gateDestructiveConfirmation", async () => {
		const runtime = createMockRuntime();
		const message: Memory = {
			entityId: "user-123",
			content: { text: "remove" },
		} as unknown as Memory;

		const gate = await gateDestructiveConfirmation({
			runtime,
			message,
			actionName: "REMOVE_ENTRY",
			pendingKey: "entry:5",
			prompt: "Remove entry 5?",
		});

		expect(gate.status).toBe("pending");
	});

	it("rejects LLM confirmed flag as authoritative", () => {
		expect(llmConfirmedFlagIsAuthoritative(true)).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative("true")).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative(1)).toBe(false);
		expect(llmConfirmedFlagIsAuthoritative({})).toBe(false);
	});
});
