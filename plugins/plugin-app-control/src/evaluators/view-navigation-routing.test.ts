import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewNavigationRoutingEvaluator } from "./view-navigation-routing.js";

// The full registered view set the loopback reports. resolveIntentView resolves
// to one of these ids; the evaluator confirms the id is registered before it
// pins the plan to VIEWS.
const REGISTERED_VIEW_IDS = [
	"calendar",
	"inbox",
	"wallet",
	"finances",
	"goals",
	"health",
	"todos",
	"documents",
	"relationships",
	"focus",
	"companion",
];

function viewSummary(id: string) {
	return {
		id,
		label: id,
		description: `${id} view`,
		pluginName: `@local/plugin-${id}`,
		available: true,
		tags: [id],
		capabilities: [],
	};
}

function message(text: string) {
	return { id: "m1", roomId: "room-1", content: { text } };
}

function context(
	text: string,
	overrides: Partial<ResponseHandlerEvaluatorContext> = {},
): ResponseHandlerEvaluatorContext {
	return {
		runtime: { agentId: "agent-1", actions: [{ name: "VIEWS" }] },
		message: message(text),
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "direct reply",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "Sure.",
				candidateActions: ["REPLY"],
			},
		},
		availableContexts: [{ id: "general" }, { id: "simple" }],
		...overrides,
	} as unknown as ResponseHandlerEvaluatorContext;
}

function mockLoopback(ids: readonly string[] = REGISTERED_VIEW_IDS) {
	vi.mocked(globalThis.fetch).mockImplementation(async () => {
		return {
			ok: true,
			status: 200,
			json: async () => ({ views: ids.map(viewSummary) }),
		} as Response;
	});
}

describe("viewNavigationRoutingEvaluator — fires + pins to VIEWS", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const NAV_CASES: Array<[string, string]> = [
		["open my calendar", "calendar"],
		["what's on my calendar", "calendar"],
		["check my messages", "inbox"],
		["show my wallet", "wallet"],
		["how much did I spend this month", "finances"],
		["I need to focus", "focus"],
		["take me to my goals", "goals"],
		["show my todos", "todos"],
		["pull up my documents", "documents"],
		["who do I know at Google", "relationships"],
		// multilingual — the cases core's English token matcher misses
		["muéstrame mi calendario", "calendar"],
		["我的钱包", "wallet"],
		["montre-moi mon portefeuille", "wallet"],
		["zeig mir meinen kalender", "calendar"],
		["ouvre mes tâches", "todos"],
		["我想看我的待办事项", "todos"],
	];

	for (const [text, view] of NAV_CASES) {
		it(`pins VIEWS for "${text}" (→ ${view})`, async () => {
			mockLoopback();
			const ctx = context(text);
			expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(true);
			await expect(
				viewNavigationRoutingEvaluator.evaluate(ctx),
			).resolves.toMatchObject({
				requiresTool: true,
				clearReply: true,
				reply: "On it.",
				clearCandidateActions: true,
				addCandidateActions: ["VIEWS"],
				addParentActionHints: ["VIEWS"],
			});
		});
	}
});

describe("viewNavigationRoutingEvaluator — does NOT fire", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const NON_NAV = [
		"tell me a joke",
		"what is 2+2",
		"write me a poem about the sea",
		"remind me to call mom",
		"thanks, that's perfect",
	];
	for (const text of NON_NAV) {
		it(`stays on the direct path for "${text}"`, async () => {
			const ctx = context(text);
			expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(false);
			// shouldRun is a cheap sync gate — no loopback for non-nav.
			expect(globalThis.fetch).not.toHaveBeenCalled();
		});
	}

	it("does not run when no VIEWS action is registered", async () => {
		const ctx = context("open my calendar", {
			runtime: { agentId: "agent-1", actions: [] },
		} as never);
		expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(false);
	});

	it("does not run when the turn is not RESPOND", async () => {
		const ctx = context("open my calendar", {
			messageHandler: {
				processMessage: "STOP",
				plan: { contexts: ["simple"], requiresTool: false },
			},
		} as never);
		expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(false);
	});
});

describe("viewNavigationRoutingEvaluator — degrades safely", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("does not route when the resolved view is not a registered view", async () => {
		// resolveIntentView says "focus" but no focus view is registered (e.g.
		// plugin-blocker not loaded) → fall back to the agent's normal reply.
		mockLoopback(REGISTERED_VIEW_IDS.filter((id) => id !== "focus"));
		const ctx = context("I need to focus");
		expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewNavigationRoutingEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});

	it("does not route when the loopback API is unreachable (non-app surface)", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
		const ctx = context("open my calendar");
		expect(await viewNavigationRoutingEvaluator.shouldRun(ctx)).toBe(true);
		await expect(
			viewNavigationRoutingEvaluator.evaluate(ctx),
		).resolves.toBeUndefined();
	});
});
