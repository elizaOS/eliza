/**
 * Shortcut evaluator tests for routing explicit view commands before tool planning.
 */

import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { viewCommandShortcutEvaluator } from "./view-command-shortcut.ts";

function ctx(
	text: string,
	opts: {
		requiresTool?: boolean;
		processMessage?: string;
		hasViews?: boolean;
		extraActions?: string[];
		candidateActions?: string[];
		parentActionHints?: string[];
	} = {},
): ResponseHandlerEvaluatorContext {
	const hasViews = opts.hasViews ?? true;
	const extraActions = (opts.extraActions ?? []).map((name) => ({ name }));
	return {
		runtime: {
			actions: hasViews
				? [{ name: "VIEWS" }, { name: "REPLY" }, ...extraActions]
				: [{ name: "REPLY" }, ...extraActions],
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
	const commands: Array<[text: string, view: string]> = [
		["open settings", "settings"],
		["go to settings view", "settings"],
		["go home", "chat"],
		["open the home dashboard", "chat"],
		["show me my calendar", "calendar"],
		["muéstrame mi calendario", "calendar"],
		["abra meu calendário", "calendar"],
		["öffne meinen kalender", "calendar"],
		["カレンダーを開いて", "calendar"],
		["캘린더 열어", "calendar"],
		["mở lịch", "calendar"],
		["buksan ang calendar", "calendar"],
		["open my inbox", "inbox"],
		["check my messages", "inbox"],
		["revisa mi correo", "inbox"],
		["show my wallet", "wallet"],
		["abre ajustes", "settings"],
		["打开设置", "settings"],
		["설정 열어", "settings"],
		["設定を開いて", "settings"],
		["open app builder", "task-coordinator"],
	];
	for (const [text, view] of commands) {
		it(`"${text}" forces VIEWS`, async () => {
			const patch = await run(text);
			expect(patch).toBeTruthy();
			expect(patch?.requiresTool).toBe(true);
			expect(viewCommandShortcutEvaluator.priority).toBeLessThan(20);
			expect(patch?.clearCandidateActions).toBe(true);
			expect(patch?.addCandidateActions).toContain("VIEWS");
			expect(patch?.clearParentActionHints).toBe(true);
			expect(patch?.addParentActionHints).toContain("VIEWS");
			expect(patch?.deterministicToolCall?.name).toBe("VIEWS");
			expect(patch?.deterministicToolCall?.params).toMatchObject({
				action: "show",
				view,
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
				params: { action: "show", view: "task-coordinator" },
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
	it("on XR camera perception requests owned by XR_QUERY_VISION", async () => {
		expect(
			await run(
				"Use XR device vision to answer: what do you see through the XR camera?",
				{ extraActions: ["XR_QUERY_VISION"] },
			),
		).toBeNull();
		expect(
			await run("open XR camera view", { extraActions: ["XR_QUERY_VISION"] }),
		).toBeTruthy();
	});
	it("when VIEWS action is not registered", async () => {
		expect(await run("open settings", { hasViews: false })).toBeNull();
	});
	it("when processMessage is STOP", async () => {
		expect(await run("open settings", { processMessage: "STOP" })).toBeNull();
	});
});
