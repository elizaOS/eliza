/** Surrogate safety for task shortId in choice.ts — exercises system under test. */
import { describe, expect, test } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { choiceAction, formatTaskShortId } from "./choice.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("choice action task id surrogate safety", () => {
	test("helper truncates at astral boundary without lone surrogate", () => {
		const fox = "🦊";
		const taskId = `${"a".repeat(7)}${fox}123456`;
		const shortId = formatTaskShortId(taskId);
		expect(isWellFormed(shortId)).toBe(true);
		expect(shortId).toBe("a".repeat(7));
		expect(() => JSON.stringify({ shortId })).not.toThrow();
	});

	test("helper keeps fitting emoji intact", () => {
		const fox = "🦊";
		const taskId = `${"a".repeat(6)}${fox}`;
		const shortId = formatTaskShortId(taskId);
		expect(isWellFormed(shortId)).toBe(true);
		expect(shortId.includes(fox)).toBe(true);
		expect(shortId.length).toBe(8);
	});

	test("lone high surrogate sanitized via helper", () => {
		const badTaskId = "task\ud800123456";
		const shortId = formatTaskShortId(badTaskId);
		expect(isWellFormed(shortId)).toBe(true);
		expect(shortId.includes("\ud800")).toBe(false);
	});

	test("choiceAction handler formats menu via production helper (both sites)", async () => {
		const fox = "🦊";
		const taskIdAstral = `${"a".repeat(7)}${fox}rest-of-uuid-1234`;
		const taskIdShort = `${"b".repeat(6)}${fox}`;
		// Mock runtime with minimal pending tasks
		const pendingTasks = [
			{
				id: taskIdAstral,
				name: "Deploy Task",
				metadata: { options: ["opt1", "opt2"] },
			},
			{
				id: taskIdShort,
				name: "Choice Task",
				metadata: { options: ["yes", "no"] },
			},
		];
		const runtime = {
			agentId: "agent-1",
			getRoom: async () => ({ messageServerId: "server-1" }),
			getTasks: async () => pendingTasks,
			getService: () => null,
		} as unknown as IAgentRuntime;
		const message = {
			entityId: "entity-1",
			roomId: "room-1",
			content: { source: "test" },
		} as unknown as Memory;
		const state = {
			data: { room: { messageServerId: "server-1" } },
		} as unknown as State;
		let capturedText = "";
		const callback = async (opts: { text: string }) => {
			capturedText = opts.text;
		};
		// Handler without taskId/selectedOption triggers menu path which uses both truncation sites
		await choiceAction.handler(runtime, message, state, {}, callback as never);
		expect(capturedText).toBeTruthy();
		// Both site truncations must be well-formed
		expect(isWellFormed(capturedText)).toBe(true);
		expect(() => JSON.stringify({ capturedText })).not.toThrow();
		// First site backs off before the boundary emoji. The full menu still
		// contains the second task's valid emoji, so well-formedness is the
		// relevant whole-string assertion rather than banning its high surrogate.
		expect(capturedText.includes("ID: aaaaaaa")).toBe(true);
		// Second site: shortId for taskIdShort (6b + fox = 8) should keep fox
		expect(capturedText.includes(fox)).toBe(true);
	});

	test("sweep offsets around 8 cap all stay well-formed via helper", () => {
		const fox = "🦊";
		for (let offset = -4; offset <= 4; offset++) {
			const n = 8 + offset;
			const taskId = `${"a".repeat(n)}${fox}${"b".repeat(5)}`;
			const shortId = formatTaskShortId(taskId);
			expect(isWellFormed(shortId)).toBe(true);
			expect(() => JSON.stringify({ shortId })).not.toThrow();
		}
	});
});
