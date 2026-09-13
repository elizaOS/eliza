/**
 * Deterministic tests for the destructive-action confirmation protocol.
 * The mocked runtime exercises pending state, expiry, cancellation, cache cleanup,
 * multilingual confirmation, and rejection of model-supplied authorization flags.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter.js";
import { AgentRuntime } from "../runtime.js";
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

	it("guarantees single-winner for concurrent affirmatives with real InMemoryDatabaseAdapter", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const runtime = {
			getCache: async <T>(key: string) => {
				const m = await adapter.getCaches<T>([key]);
				return m.get(key);
			},
			setCache: async (key: string, value: unknown) => {
				return adapter.setCaches([{ key, value }]);
			},
			deleteCache: async (key: string) => {
				return adapter.deleteCaches([key]);
			},
		} as unknown as IAgentRuntime;

		const message: Memory = {
			entityId: "user-race-real",
			content: { text: "delete database", source: "discord" },
		} as unknown as Memory;

		// 1. Initial request -> pending
		await requireConfirmation({
			runtime,
			message,
			actionName: "DELETE_DB",
			prompt: "Confirm delete?",
		});

		// 2. Two concurrent confirmations racing on real adapter
		const confirmMsg: Memory = {
			entityId: "user-race-real",
			content: { text: "yes", source: "discord" },
		} as unknown as Memory;

		const [res1, res2] = await Promise.all([
			requireConfirmation({
				runtime,
				message: confirmMsg,
				actionName: "DELETE_DB",
				prompt: "Confirm delete?",
			}),
			requireConfirmation({
				runtime,
				message: confirmMsg,
				actionName: "DELETE_DB",
				prompt: "Confirm delete?",
			}),
		]);

		const confirmedCount = [res1.status, res2.status].filter(
			(s) => s === "confirmed",
		).length;
		expect(confirmedCount).toBe(1);
	});
});
