/**
 * View context evaluator tests for model-guided navigation from situational cues.
 */

import type {
	EvaluatorPromptContext,
	EvaluatorRunContext,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BASELINE_VIEW_CONTEXT_INSTRUCTION,
	type ViewContextOutput,
	viewContextEvaluator,
} from "./view-context.js";

const REGISTERED_VIEW_IDS = [
	"calendar",
	"inbox",
	"wallet",
	"finances",
	"todos",
	"goals",
	"health",
	"documents",
	"relationships",
	"focus",
	"task-coordinator",
];

function viewSummary(id: string) {
	return {
		id,
		label: id,
		description: `${id} view`,
		path: `/${id}`,
		pluginName: `@local/plugin-${id}`,
		available: true,
		viewType: "gui",
		tags: [id],
	};
}

/** Mock the loopback: list views, current view, capture navigate POSTs. */
function mockLoopback(opts: {
	ids?: readonly string[];
	current?: string | null;
}) {
	const navigated: string[] = [];
	const ids = opts.ids ?? REGISTERED_VIEW_IDS;
	vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
		const u = String(url);
		const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
		if (nav) {
			navigated.push(decodeURIComponent(nav[1]));
			return {
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response;
		}
		if (u.endsWith("/api/views/current")) {
			return {
				ok: true,
				status: 200,
				json: async () => ({
					currentView: opts.current
						? {
								viewId: opts.current,
								viewPath: `/${opts.current}`,
								viewLabel: opts.current,
								viewType: "gui",
								updatedAt: "2026-06-18T00:00:00.000Z",
							}
						: null,
				}),
			} as Response;
		}
		return {
			ok: true,
			status: 200,
			json: async () => ({ views: ids.map(viewSummary) }),
		} as Response;
	});
	return { navigated };
}

function ctx(
	text: string,
	overrides: Partial<EvaluatorRunContext> = {},
): EvaluatorRunContext {
	return {
		runtime: { actions: [{ name: "VIEWS" }] },
		message: { id: "m1", roomId: "r1", content: { text } },
		options: { didRespond: true },
		...overrides,
	} as unknown as EvaluatorRunContext;
}

async function runProcessor(
	output: ViewContextOutput,
	text = "fix the login bug",
) {
	const processor = viewContextEvaluator.processors?.[0];
	if (!processor) throw new Error("no processor");
	return processor.process({
		output,
		message: { id: "m1", roomId: "r1", content: { text } },
	} as never);
}

describe("viewContextEvaluator.shouldRun — contextual gate", () => {
	const CONTEXTUAL = [
		"can you fix the login bug",
		"I've got back-to-back meetings tomorrow",
		"help me cut my monthly spending",
		"let's build a new feature for the app",
		"I keep getting distracted while working",
	];
	for (const text of CONTEXTUAL) {
		it(`runs for contextual activity: "${text}"`, async () => {
			expect(await viewContextEvaluator.shouldRun(ctx(text))).toBe(true);
		});
	}

	it("defers to the VIEWS action on a DIRECT nav command (resolveIntentView match)", async () => {
		// "open my calendar" / "muéstrame mi calendario" are direct → the action's job.
		expect(await viewContextEvaluator.shouldRun(ctx("open my calendar"))).toBe(
			false,
		);
		expect(
			await viewContextEvaluator.shouldRun(ctx("muéstrame mi calendario")),
		).toBe(false);
	});

	it("does not run on small talk / non-activity", async () => {
		expect(
			await viewContextEvaluator.shouldRun(ctx("thanks, that helped")),
		).toBe(false);
		expect(await viewContextEvaluator.shouldRun(ctx("how are you today"))).toBe(
			false,
		);
	});

	it("does not run on a trivially short message", async () => {
		expect(await viewContextEvaluator.shouldRun(ctx("hi"))).toBe(false);
	});

	it("does not contextually map standalone notes requests to Knowledge", async () => {
		expect(await viewContextEvaluator.shouldRun(ctx("open notes"))).toBe(false);
		expect(await viewContextEvaluator.shouldRun(ctx("show me my notes"))).toBe(
			false,
		);
	});

	it("does not run when VIEWS is not registered", async () => {
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("fix the login bug", { runtime: { actions: [] } } as never),
			),
		).toBe(false);
	});

	it("does not run when the agent did not respond", async () => {
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("fix the login bug", { options: { didRespond: false } }),
			),
		).toBe(false);
	});
});

describe("viewContextEvaluator.prompt — GEPA-optimizable instruction", () => {
	it("falls back to the baseline instruction when no optimized artifact is registered", () => {
		// resolveOptimizedPromptForRuntime returns the baseline when the service is
		// absent (runtime.getService undefined), so the prompt = baseline + the
		// per-turn user message.
		const promptCtx = {
			runtime: { actions: [{ name: "VIEWS" }] },
			message: { content: { text: "fix the login bug" } },
			state: { values: {}, data: {}, text: "" },
			options: { didRespond: true },
			prepared: undefined,
		} as unknown as EvaluatorPromptContext;
		const out = viewContextEvaluator.prompt(promptCtx);
		expect(out).toContain(BASELINE_VIEW_CONTEXT_INSTRUCTION);
		expect(out).toContain("fix the login bug");
	});
});

describe("viewContextEvaluator.parse — output validation", () => {
	it("accepts a registered view id", () => {
		expect(
			viewContextEvaluator.parse?.({ viewId: "task-coordinator" }),
		).toEqual({ viewId: "task-coordinator", reason: undefined });
	});
	it("lower-cases + keeps reason", () => {
		expect(
			viewContextEvaluator.parse?.({ viewId: "Calendar", reason: "meetings" }),
		).toEqual({ viewId: "calendar", reason: "meetings" });
	});
	it('accepts "none"', () => {
		expect(viewContextEvaluator.parse?.({ viewId: "none" })).toEqual({
			viewId: "none",
			reason: undefined,
		});
	});
	it("rejects an unknown view id", () => {
		expect(viewContextEvaluator.parse?.({ viewId: "spaceship" })).toBeNull();
	});
	it("rejects a non-object", () => {
		expect(viewContextEvaluator.parse?.("nope")).toBeNull();
	});
});

describe("viewContextEvaluator processor — navigates on the (mock-LLM) decision", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("navigates to the situation-inferred view (coding → task-coordinator)", async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor({
			viewId: "task-coordinator",
			reason: "coding work",
		});
		expect(navigated).toEqual(["task-coordinator"]);
		expect(result).toMatchObject({
			success: true,
			values: { contextualView: "task-coordinator" },
		});
	});

	it('does NOT navigate when the decision is "none"', async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor({ viewId: "none" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("does NOT navigate to a view that is not registered in this deployment", async () => {
		const { navigated } = mockLoopback({
			ids: REGISTERED_VIEW_IDS.filter((id) => id !== "task-coordinator"),
			current: "chat",
		});
		const result = await runProcessor({ viewId: "task-coordinator" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("does NOT navigate to documents when the user asked for notes", async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor(
			{ viewId: "documents", reason: "user requested notes" },
			"open notes",
		);
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("does NOT re-navigate when already on the target view", async () => {
		const { navigated } = mockLoopback({ current: "calendar" });
		const result = await runProcessor({ viewId: "calendar" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("degrades to no-op when the loopback is unreachable", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await runProcessor({ viewId: "task-coordinator" });
		expect(result).toBeUndefined();
	});
});
