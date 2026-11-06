/** A destructive confirmation settles only on a plain yes or no in the room that showed it. */
import { describe, expect, it } from "vitest";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";
import type { IAgentRuntime } from "../src/types/runtime";
import {
	isAffirmativeConfirmationReply,
	requireConfirmation,
} from "../src/utils/confirmation";

const user = "00000000-0000-4000-8000-0000000000b1" as UUID;
const roomA = "00000000-0000-4000-8000-0000000000a1" as UUID;
const roomB = "00000000-0000-4000-8000-0000000000a2" as UUID;

function cacheRuntime(): IAgentRuntime {
	const cache = new Map<string, unknown>();
	return {
		getCache: async (key: string) => cache.get(key),
		setCache: async (key: string, value: unknown) => {
			cache.set(key, value);
			return true;
		},
		deleteCache: async (key: string) => cache.delete(key),
	} as unknown as IAgentRuntime;
}

let nextId = 0;
function turn(text: string, roomId: UUID = roomA): Memory {
	nextId++;
	return {
		id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}` as UUID,
		entityId: user,
		roomId,
		content: { text },
	} as Memory;
}

async function ask(
	runtime: IAgentRuntime,
	message: Memory,
	prompts: string[] = [],
) {
	return requireConfirmation({
		runtime,
		message,
		actionName: "CONTACT",
		pendingKey: "remove:ann",
		prompt: "Remove Ann Smith from your contacts permanently?",
		callback: async (content) => {
			prompts.push(content.text ?? "");
			return [];
		},
	});
}

async function replyTo(text: string) {
	const runtime = cacheRuntime();
	await ask(runtime, turn("delete Ann Smith"));
	return (await ask(runtime, turn(text))).status;
}

describe("requireConfirmation", () => {
	it.each([
		"yes",
		"Yes.",
		"ok",
		"okay!",
		"sure",
		"yes please",
		"ok, go ahead",
		"do it",
		"sí",
		"Sí, por favor",
		"oui",
		"はい",
	])("confirms the plain yes %j", async (text) => {
		expect(await replyTo(text)).toBe("confirmed");
	});

	it.each([
		"no",
		"ok, never mind",
		"Okay so actually don't",
		"sure... wait no",
		"yes, but not Ann",
		"sí, pero no",
		"no, gracias",
		"cancel",
	])("cancels on the no %j", async (text) => {
		expect(await replyTo(text)).toBe("cancelled");
	});

	it.each(["okay thanks", "y?", "please delete Ann", "what?", "please", ""])(
		"asks again on the unclear reply %j",
		async (text) => {
			expect(await replyTo(text)).toBe("pending");
		},
	);

	it("asks again on an unclear reply, then confirms the yes that follows", async () => {
		const runtime = cacheRuntime();
		const prompts: string[] = [];
		await ask(runtime, turn("delete Ann Smith"), prompts);
		expect((await ask(runtime, turn("okay thanks"), prompts)).status).toBe(
			"pending",
		);
		expect(prompts).toHaveLength(2);
		expect((await ask(runtime, turn("yes"), prompts)).status).toBe("confirmed");
	});

	it("does not accept a yes from another room, and the prompted room still confirms", async () => {
		const runtime = cacheRuntime();
		const prompts: string[] = [];
		await ask(runtime, turn("delete Ann Smith", roomA), prompts);

		expect((await ask(runtime, turn("okay", roomB), prompts)).status).toBe(
			"pending",
		);
		expect(prompts).toHaveLength(2);

		expect((await ask(runtime, turn("yes", roomA), prompts)).status).toBe(
			"confirmed",
		);
	});

	it("keeps waiting when the requesting message runs the action again", async () => {
		const runtime = cacheRuntime();
		const request = turn("yes, delete Ann Smith");
		await ask(runtime, request);
		expect((await ask(runtime, request)).status).toBe("pending");
	});
});

describe("isAffirmativeConfirmationReply", () => {
	it("is true only for a plain yes", () => {
		expect(isAffirmativeConfirmationReply(turn("yes"))).toBe(true);
		expect(isAffirmativeConfirmationReply(turn("ok, never mind"))).toBe(false);
		expect(isAffirmativeConfirmationReply(turn("okay thanks"))).toBe(false);
	});
});
