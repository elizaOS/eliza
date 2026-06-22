import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { viewCommandShortcutEvaluator } from "./view-command-shortcut.ts";

function ctx(
	text: string,
	opts: {
		requiresTool?: boolean;
		processMessage?: string;
		hasViews?: boolean;
		candidateActions?: string[];
		parentActionHints?: string[];
	} = {},
): ResponseHandlerEvaluatorContext {
	const hasViews = opts.hasViews ?? true;
	return {
		runtime: {
			actions: hasViews
				? [{ name: "VIEWS" }, { name: "REPLY" }]
				: [{ name: "REPLY" }],
		},
		message: { content: { text } },
		state: {},
		messageHandler: {
			processMessage: opts.processMessage ?? "RESPOND",
			plan: {
				requiresTool: opts.requiresTool ?? false,
				candidateActions: opts.candidateActions,
				parentActionHints: opts.parentActionHints,
			},
		},
		availableContexts: [],
	} as unknown as ResponseHandlerEvaluatorContext;
}

async function run(text: string, opts = {}) {
	const c = ctx(text, opts);
	const should = await viewCommandShortcutEvaluator.shouldRun(c);
	if (!should) return null;
	return viewCommandShortcutEvaluator.evaluate(c);
}

describe("viewCommandShortcutEvaluator — forces VIEWS on explicit commands", () => {
	const commands = [
		"open settings",
		"go to settings view",
		"show me my calendar",
		"muéstrame mi calendario",
		"abra meu calendário",
		"öffne meinen kalender",
		"カレンダーを開いて",
		"캘린더 열어",
		"mở lịch",
		"buksan ang calendar",
		"open my inbox",
		"check my messages",
		"revisa mi correo",
		"show my wallet",
		"abre ajustes", // es
		"打开设置", // zh
		"설정 열어", // ko
		"設定を開いて", // ja
		"open app builder",
	];
	for (const text of commands) {
		it(`"${text}" forces VIEWS`, async () => {
			const patch = await run(text);
			expect(patch).toBeTruthy();
			expect(patch?.requiresTool).toBe(true);
			expect(viewCommandShortcutEvaluator.priority).toBeLessThan(20);
			expect(patch?.clearCandidateActions).toBe(true);
			expect(patch?.addCandidateActions).toContain("VIEWS");
			expect(patch?.clearParentActionHints).toBe(true);
			expect(patch?.addParentActionHints).toContain("VIEWS");
			expect(patch?.deterministicToolCall).toEqual({
				name: "VIEWS",
				params: { action: "show" },
			});
		});
	}

	it("overrides an already-tool-marked explicit view command", async () => {
		const patch = await run("open app builder", {
			requiresTool: true,
			candidateActions: ["CODING_TOOLS"],
			parentActionHints: ["CODING_TOOLS"],
		});

		expect(patch).toMatchObject({
			requiresTool: true,
			clearCandidateActions: true,
			addCandidateActions: ["VIEWS"],
			clearParentActionHints: true,
			addParentActionHints: ["VIEWS"],
			deterministicToolCall: {
				name: "VIEWS",
				params: { action: "show" },
			},
		});
	});
});

describe("viewCommandShortcutEvaluator — does NOT fire", () => {
	it("on non-navigation chatter", async () => {
		expect(await run("what's the weather like")).toBeNull();
		expect(await run("tell me a joke")).toBeNull();
	});
	it("on contextual intent (left to the post evaluator)", async () => {
		expect(await run("i need to fix the login bug")).toBeNull();
		expect(await run("I want to add a new feature to my app")).toBeNull();
	});
	it("when VIEWS action is not registered", async () => {
		expect(await run("open settings", { hasViews: false })).toBeNull();
	});
	it("when processMessage is STOP", async () => {
		expect(await run("open settings", { processMessage: "STOP" })).toBeNull();
	});
});
