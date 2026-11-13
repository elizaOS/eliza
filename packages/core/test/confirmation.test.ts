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
		"yes, clear them",
		"yes delete it",
		"ok block x.com",
		"please, yes",
		"yes please do that",
		"yes, thanks",
		"okay, go ahead, thanks",
		"oui, vas-y",
		"ja, bitte",
		"确认，现在删除",
		"はい、お願いします",
		"확인, 지금 삭제해 주세요",
		"확인, 그만큼 진행해 주세요",
		"확인, 그만큼만 진행해 주세요",
		"확인, 취소선을 넣어 주세요",
		"확인, 취소선으로 표시해 주세요",
	])("confirms the yes %j", async (text) => {
		expect(await replyTo(text)).toBe("confirmed");
	});

	it.each([
		"no",
		"ok, never mind",
		"Okay so actually don't",
		"sure... wait no",
		"yes, but not Ann",
		"sí, pero no",
		"oui, mais pas maintenant",
		"ja, aber nicht jetzt",
		"确认，先不要",
		"确认，但不要删",
		"确认，取消吧",
		"はい、やっぱりいいえ",
		"확인 안 해요",
		"확인, 못 하겠어요",
		"확인 취소",
		"확인, 취소할게요",
		"확인, 아니에요",
		"확인, 그만",
		"확인, 삭제하지 마세요",
		"확인, 하지 않을게요",
		"확인, 취소를 원해요",
		"확인, 그만둬요",
		"no, gracias",
		"cancel",
		"n",
		"nvm",
		"abort",
		"never mind",
		"negative",
		"👎",
		"❌",
	])("cancels on the no %j", async (text) => {
		expect(await replyTo(text)).toBe("cancelled");
	});

	it.each([
		"okay thanks",
		"sure, thank you",
		"y?",
		"yes, which one?",
		"please delete Ann",
		"delete it, yes",
		"what?",
		"please",
		"",
	])("asks again on the unclear reply %j", async (text) => {
		expect(await replyTo(text)).toBe("pending");
	});

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

	it("keeps the first ask's metadata when a re-ask passes none", async () => {
		const runtime = cacheRuntime();
		const confirm = (text: string, metadata?: Record<string, unknown>) =>
			requireConfirmation({
				runtime,
				message: turn(text),
				actionName: "TRADE",
				pendingKey: "order",
				prompt: "Submit the order?",
				metadata,
			});
		await confirm("buy btc", { idempotencyKey: "k1" });
		expect((await confirm("okay thanks")).status).toBe("pending");
		expect(await confirm("yes")).toEqual({
			status: "confirmed",
			metadata: { idempotencyKey: "k1" },
		});
	});

	it("keeps waiting when the requesting message runs the action again", async () => {
		const runtime = cacheRuntime();
		// Its text alone would confirm; only the message id tells it apart.
		const request = turn("yes");
		await ask(runtime, request);
		expect((await ask(runtime, request)).status).toBe("pending");
		expect((await ask(runtime, turn("yes"))).status).toBe("confirmed");
	});
});

describe("isAffirmativeConfirmationReply", () => {
	it("is true only for a reply that opens with a yes and has no no", () => {
		expect(isAffirmativeConfirmationReply(turn("yes"))).toBe(true);
		expect(isAffirmativeConfirmationReply(turn("yes, clear them"))).toBe(true);
		expect(isAffirmativeConfirmationReply(turn("ok, never mind"))).toBe(false);
		expect(isAffirmativeConfirmationReply(turn("okay thanks"))).toBe(false);
	});
});
