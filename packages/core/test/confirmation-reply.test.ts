import { expect, test } from "vitest";
import type { HandlerCallback } from "../src/types/components.ts";
import type { Memory } from "../src/types/memory.ts";
import type { UUID } from "../src/types/primitives.ts";
import type { IAgentRuntime } from "../src/types/runtime.ts";
import {
	isAffirmativeConfirmationReply,
	requireConfirmation,
} from "../src/utils/confirmation.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000002" as UUID;

function reply(text: string, id?: string): Memory {
	return {
		...(id ? { id: id as UUID } : {}),
		entityId: USER_ID,
		roomId: ROOM_ID,
		content: { text },
	};
}

function cacheRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		getCache: async (key: string) => cache.get(key),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => {
			cache.delete(key);
			return true;
		},
	} as IAgentRuntime;
}

test("a yes reply is the whole message, not a prefix", () => {
	const accepted = [
		"yes",
		" YES ",
		"yes!",
		"yes.",
		"yes, please",
		"ok please",
		"do it",
		"go ahead",
		"sí",
		"はい",
		"确认",
		"“yes”",
		"(yes)",
	];
	for (const text of accepted) {
		expect(isAffirmativeConfirmationReply(reply(text)), text).toBe(true);
	}

	const rejected = [
		"yes, but don't",
		"yes, don't send yet",
		"Yes, delete it",
		"Yes, delete it.",
		"yes 👍",
		"yes?",
		"go ahead and delete the rest",
		"do it now",
		"okay thanks",
		"y no",
		"sí, no",
		"はい、やめて",
		"yeah whatever",
		"no",
		"do not",
	];
	for (const text of rejected) {
		expect(isAffirmativeConfirmationReply(reply(text)), text).toBe(false);
	}
});

test("a custom detector stays under the caller's contract", () => {
	expect(
		isAffirmativeConfirmationReply(reply("yes, but don't"), /^yes\b/i),
	).toBe(true);
});

test("a qualified reply cancels the pending destructive action", async () => {
	const runtime = cacheRuntime();
	const prompts: string[] = [];
	const callback: HandlerCallback = async (content) => {
		prompts.push(content.text ?? "");
		return [];
	};
	const args = {
		runtime,
		actionName: "DELETE_RECORD",
		pendingKey: "delete:1",
		prompt: "Delete this record?",
		callback,
	};

	const preview = await requireConfirmation({
		...args,
		message: reply("delete it", "request"),
	});
	expect(preview.status).toBe("pending");
	expect(prompts).toEqual(["Delete this record?"]);

	const qualified = await requireConfirmation({
		...args,
		message: reply("yes, but don't", "reply"),
	});
	expect(qualified.status).toBe("cancelled");

	const laterYes = await requireConfirmation({
		...args,
		message: reply("yes", "later"),
	});
	expect(laterYes.status).toBe("pending");
});

test("a qualified delete reply and a yes with an emoji cancel with no helper hint", async () => {
	for (const text of ["Yes, delete it", "Yes, delete it.", "yes 👍"]) {
		const runtime = cacheRuntime();
		const prompts: string[] = [];
		const callback: HandlerCallback = async (content) => {
			prompts.push(content.text ?? "");
			return [];
		};
		const args = {
			runtime,
			actionName: "DELETE_RECORD",
			pendingKey: "delete:1",
			prompt: "Delete this record?",
			callback,
		};
		expect(
			(
				await requireConfirmation({
					...args,
					message: reply("delete it", "request"),
				})
			).status,
		).toBe("pending");
		const cancelled = await requireConfirmation({
			...args,
			message: reply(text, "reply"),
		});
		expect(cancelled.status, text).toBe("cancelled");
		expect(cancelled, text).not.toHaveProperty("text");
		expect(prompts, text).toEqual(["Delete this record?"]);

		const laterYes = await requireConfirmation({
			...args,
			message: reply("yes", "later"),
		});
		expect(laterYes.status, text).toBe("pending");
		expect(prompts, text).toEqual([
			"Delete this record?",
			"Delete this record?",
		]);
	}
});

test("a later reply that is only yes confirms the pending action", async () => {
	const runtime = cacheRuntime();
	const args = {
		runtime,
		actionName: "DELETE_RECORD",
		pendingKey: "delete:1",
		prompt: "Delete this record?",
	};
	expect(
		(
			await requireConfirmation({
				...args,
				message: reply("delete it", "request"),
			})
		).status,
	).toBe("pending");
	expect(
		(
			await requireConfirmation({
				...args,
				message: reply("yes!", "reply"),
			})
		).status,
	).toBe("confirmed");
});
