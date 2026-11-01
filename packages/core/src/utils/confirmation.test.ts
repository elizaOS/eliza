import { expect, it } from "vitest";
import type { Memory } from "../types/memory.ts";
import { requireConfirmation } from "./confirmation.ts";

function fakeRuntime(cache: Map<string, unknown>) {
	return {
		getCache: <T>(key: string) =>
			Promise.resolve((cache.get(key) as T) ?? undefined),
		setCache: (key: string, value: unknown) => {
			cache.set(key, value);
			return Promise.resolve();
		},
		deleteCache: (key: string) => {
			cache.delete(key);
			return Promise.resolve();
		},
	};
}

function memory(input: Partial<Memory> & { entityId: string }): Memory {
	return { createdAt: Date.now(), content: { text: "" }, ...input };
}

it("does not let a same-turn replay of an id-less message self-confirm", async () => {
	const cache = new Map<string, unknown>();
	const runtime = fakeRuntime(cache) as never;
	// The planner invoked the action twice inside one turn: both invocations
	// receive the same message object, whose text already reads affirmative.
	const message = memory({
		entityId: "user-1",
		content: { text: "yes, unsubscribe me from that newsletter" },
	});
	const first = await requireConfirmation({
		runtime,
		message,
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m1",
		prompt: "Unsubscribe?",
	});
	expect(first.status).toBe("pending");
	const second = await requireConfirmation({
		runtime,
		message,
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m1",
		prompt: "Unsubscribe?",
	});
	// The same turn's message must not count as the owner's reply to the
	// prompt it triggered (documented invariant; ids make this hold, so an
	// id-less message must be held to the same standard).
	expect(second.status).toBe("pending");
});

it("keeps confirming a genuinely later id-less reply by createdAt turnover", async () => {
	const cache = new Map<string, unknown>();
	const runtime = fakeRuntime(cache) as never;
	const first = await requireConfirmation({
		runtime,
		message: memory({
			entityId: "user-1",
			createdAt: 1_000,
			content: { text: "unsubscribe me from that newsletter" },
		}),
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m2",
		prompt: "Unsubscribe?",
	});
	expect(first.status).toBe("pending");
	const second = await requireConfirmation({
		runtime,
		message: memory({
			entityId: "user-1",
			createdAt: 2_000,
			content: { text: "yes" },
		}),
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m2",
		prompt: "Unsubscribe?",
	});
	expect(second.status).toBe("confirmed");
});

it("still refuses a later id-less reply that is not affirmative", async () => {
	const cache = new Map<string, unknown>();
	const runtime = fakeRuntime(cache) as never;
	await requireConfirmation({
		runtime,
		message: memory({
			entityId: "user-1",
			createdAt: 1_000,
			content: { text: "unsubscribe me from that newsletter" },
		}),
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m3",
		prompt: "Unsubscribe?",
	});
	const second = await requireConfirmation({
		runtime,
		message: memory({
			entityId: "user-1",
			createdAt: 2_000,
			content: { text: "wait, not yet" },
		}),
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m3",
		prompt: "Unsubscribe?",
	});
	expect(second.status).toBe("cancelled");
});

it("keeps the documented id-based same-message guard", async () => {
	const cache = new Map<string, unknown>();
	const runtime = fakeRuntime(cache) as never;
	const message = memory({
		id: "mem-1",
		entityId: "user-1",
		content: { text: "yes" },
	});
	const first = await requireConfirmation({
		runtime,
		message,
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m4",
		prompt: "Unsubscribe?",
	});
	expect(first.status).toBe("pending");
	const second = await requireConfirmation({
		runtime,
		message,
		actionName: "MESSAGE_UNSUBSCRIBE",
		pendingKey: "unsubscribe:m4",
		prompt: "Unsubscribe?",
	});
	expect(second.status).toBe("pending");
});
