/** Replays the replies of quint/ConfirmationReply.qnt through requireConfirmation. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Memory } from "../src/types/memory";
import type { UUID } from "../src/types/primitives";
import { requireConfirmation } from "../src/utils/confirmation";
import { createInitializedRuntime } from "./initialized-runtime";

// The model's words: 0 the language's yes, 1 its word for "not", 2 an
// ordinary word. Chinese and Japanese put no space between words.
const LANGUAGES = [
	{ name: "English", words: ["yes", "not", "now"], comma: "," },
	{ name: "Spanish", words: ["sí", "no", "ahora"], comma: "," },
	{ name: "French", words: ["oui", "pas", "maintenant"], comma: "," },
	{ name: "German", words: ["ja", "nicht", "jetzt"], comma: "," },
	{ name: "Korean", words: ["확인", "아니요", "지금"], comma: "," },
	{ name: "Chinese", words: ["确认", "不要", "现在"], comma: "，" },
	{ name: "Japanese", words: ["はい", "いいえ", "今"], comma: "、" },
] as const;
const STATUSES = ["pending", "confirmed", "cancelled"] as const;

/** One prompt and the replies to it, with the model's status after each. */
interface ModelCase {
	language: number;
	replies: Array<{ reply: number[]; status: number }>;
}

/**
 * A comma follows the first word ("oui, maintenant pas"). Chinese and
 * Japanese use their own comma and no spaces ("确认，现在不要").
 */
function render(language: number, reply: number[]): string {
	const { words, comma } = LANGUAGES[language];
	const [first, ...rest] = reply.map((word) => words[word]);
	if (rest.length === 0) return first;
	return comma === ","
		? `${first}, ${rest.join(" ")}`
		: `${first}${comma}${rest.join("")}`;
}

// Without generated cases, each language replays the same replies.
const DEFAULT_REPLIES: Array<{ reply: number[]; status: number }> = [
	{ reply: [0], status: 1 },
	{ reply: [0, 2], status: 1 },
	{ reply: [0, 1], status: 2 },
	{ reply: [0, 2, 1], status: 2 },
	{ reply: [0, 1, 2], status: 2 },
	{ reply: [1], status: 2 },
	{ reply: [2, 0], status: 0 },
];
const casesFile = process.env.ELIZA_CONFIRMATION_REPLY_MODEL_CASES;
const cases: ModelCase[] = casesFile
	? JSON.parse(readFileSync(casesFile, "utf8"))
	: LANGUAGES.flatMap((_, language) =>
			DEFAULT_REPLIES.map((step) => ({ language, replies: [step] })),
		);

const user = "00000000-0000-4000-8000-0000000000b1" as UUID;
const room = "00000000-0000-4000-8000-0000000000a1" as UUID;
let nextId = 0;
function turn(text: string): Memory {
	nextId++;
	return {
		id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}` as UUID,
		entityId: user,
		roomId: room,
		content: { text },
	} as Memory;
}

describe("confirmation reply model", () => {
	it.each(LANGUAGES.map((language, index) => [language.name, index] as const))(
		"replays the confirmation reply model in %s",
		async (_name, language) => {
			const runtime = await createInitializedRuntime({
				character: { name: "Confirmation replies", bio: [] },
				logLevel: "fatal",
			});
			const own = cases.filter((item) => item.language === language);
			expect(own.length).toBeGreaterThan(0);
			for (const [index, item] of own.entries()) {
				const ask = (message: Memory) =>
					requireConfirmation({
						runtime,
						message,
						actionName: "CONTACT",
						pendingKey: `remove:${language}:${index}`,
						prompt: "Remove Ann Smith from your contacts permanently?",
						callback: async () => [],
					});
				expect((await ask(turn("delete Ann Smith"))).status).toBe("pending");
				for (const step of item.replies) {
					const text = render(language, step.reply);
					const { status } = await ask(turn(text));
					expect({ text, status }).toEqual({
						text,
						status: STATUSES[step.status],
					});
				}
			}
		},
	);
});
