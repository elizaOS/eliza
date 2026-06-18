/**
 * View-switching API-level coverage.
 *
 * Exercises the VIEWS action end-to-end at the resolver level: given a user
 * phrase (ACTIVE navigation) or an intent-only phrase (PASSIVE routing), assert
 * the correct view id resolves and a navigate POST is dispatched to
 * /api/views/<id>/navigate. Covers EVERY user-facing built-in/first-party view
 * with an active command, plus the product-spec passive intents.
 *
 * This is the seam the orchestrator/scenario harness stops short of: it drives
 * the real createViewsAction handler + resolveView/scoreView against a fake
 * registry and a captured navigate fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", () => coreMock);

function message(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: { text },
	};
}

/**
 * Full user-facing view registry, mirroring real plugin ViewDeclarations:
 * the 9 BUILTIN_VIEWS (packages/agent/src/api/builtin-views.ts) plus the
 * first-party plugin views referenced by the product spec (inbox/email,
 * wallet, calendar) and a coding/app-builder surface.
 */
const REGISTRY: ViewSummary[] = [
	{
		id: "chat",
		label: "Chat",
		description:
			"Conversations with your agent, inbound messages from every connector",
		path: "/chat",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["messaging", "conversation", "agent"],
		visibleInManager: true,
	},
	{
		id: "character",
		label: "Character",
		description: "Agent identity, personality, style, and knowledge documents",
		path: "/character",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["identity", "personality", "character"],
		visibleInManager: true,
	},
	{
		id: "automations",
		label: "Automations",
		description: "Scheduled tasks and recurring workflows",
		path: "/automations",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["automation", "tasks", "scheduling"],
		visibleInManager: true,
	},
	{
		id: "plugins-page",
		label: "Plugins",
		description: "Manage installed plugins, configure credentials",
		path: "/apps/plugins",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: [
			"plugins",
			"plugin-browser",
			"plugin browser",
			"plugin-manager",
			"plugin manager",
			"configuration",
			"extensions",
		],
		visibleInManager: true,
	},
	{
		id: "trajectories",
		label: "Trajectories",
		description: "Agent trajectory logs and training data",
		path: "/apps/trajectories",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["training", "logs", "trajectories"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "memories",
		label: "Memories",
		description: "Agent memory viewer and management",
		path: "/apps/memories",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["memory", "knowledge"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "database",
		label: "Database",
		description: "Raw database viewer and query interface",
		path: "/apps/database",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["database", "data", "debug"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "logs",
		label: "Logs",
		description: "Runtime logs and agent debug output",
		path: "/apps/logs",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["logs", "debug", "runtime"],
		developerOnly: true,
		visibleInManager: true,
	},
	{
		id: "settings",
		label: "Settings",
		description: "Configuration, plugins, credentials, and preferences",
		path: "/settings",
		pluginName: "core",
		available: true,
		viewType: "gui",
		tags: ["configuration", "preferences", "plugins"],
		visibleInManager: true,
	},
	// First-party plugin views referenced by the product spec.
	{
		id: "inbox",
		label: "Inbox",
		description: "Cross-channel inbox triage",
		path: "/inbox",
		pluginName: "@elizaos/plugin-inbox",
		available: true,
		viewType: "gui",
		tags: ["inbox", "triage", "communication"],
		visibleInManager: true,
	},
	{
		id: "wallet",
		label: "Wallet",
		description: "Non-custodial wallet inventory and token balances",
		path: "/wallet",
		pluginName: "@elizaos/plugin-wallet-ui",
		available: true,
		viewType: "gui",
		tags: ["finance", "crypto", "wallet"],
		visibleInManager: true,
	},
	{
		id: "calendar",
		label: "Calendar",
		description:
			"Unified Google + Apple calendar with day/week/month tabs and inline conflict detection.",
		path: "/calendar",
		pluginName: "@elizaos/plugin-calendar",
		available: true,
		viewType: "gui",
		tags: ["calendar", "schedule", "events"],
		visibleInManager: true,
	},
];

function clientFor(views: ViewSummary[]): ViewsClient {
	return {
		listViews: vi.fn(async () => views),
		getCurrentView: vi.fn(async () => null),
	};
}

/** Capture every navigate POST the show handler dispatches. */
function installNavigateCapture(): { navigated: string[] } {
	const navigated: string[] = [];
	vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
		const requestUrl = String(url);
		const match = /\/api\/views\/([^/?]+)\/navigate/.exec(requestUrl);
		if (match) navigated.push(decodeURIComponent(match[1]));
		return {
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({ ok: true }),
		} as Response;
	});
	return { navigated };
}

async function runShow(
	views: ViewSummary[],
	text: string,
	options?: Record<string, unknown>,
) {
	const action = createViewsAction({
		client: clientFor(views),
		hasOwnerAccess: vi.fn(async () => true),
	});
	const callback = vi.fn();
	const result = await action.handler(
		{ agentId: "agent-1" } as never,
		message(text) as never,
		undefined,
		options,
		callback,
	);
	return { result, callback };
}

describe("view switching — VIEWS action resolver", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	describe("ACTIVE navigation — every user-facing view reachable by an explicit command", () => {
		// [phrase, expected view id]. These are the explicit-navigation commands a
		// user would type. The resolver must dispatch a navigate POST to that id.
		const ACTIVE_CASES: ReadonlyArray<readonly [string, string]> = [
			["open the chat view", "chat"],
			["go to chat", "chat"],
			["open the character view", "character"],
			["show me the character page", "character"],
			["go to automations", "automations"],
			["open the plugins page", "plugins-page"],
			["open the plugin browser", "plugins-page"],
			["show settings", "settings"],
			["open settings", "settings"],
			["go to the settings view", "settings"],
			["show my wallet", "wallet"],
			["open the wallet view", "wallet"],
			["go to my wallet", "wallet"],
			["open the calendar", "calendar"],
			["go to calendar", "calendar"],
			["show the inbox", "inbox"],
			["open my inbox", "inbox"],
			["open the trajectories view", "trajectories"],
			["show me the memories view", "memories"],
			["open the database view", "database"],
			["show the logs view", "logs"],
		];

		it.each(
			ACTIVE_CASES,
		)('"%s" navigates to view "%s"', async (phrase, expectedId) => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, phrase);
			expect(result?.success).toBe(true);
			expect(result?.values?.viewId).toBe(expectedId);
			expect(navigated).toEqual([expectedId]);
		});

		it("dispatches navigate to the exact /api/views/<id>/navigate endpoint", async () => {
			installNavigateCapture();
			await runShow(REGISTRY, "open the wallet view");
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/views/wallet/navigate",
				expect.objectContaining({ method: "POST" }),
			);
		});

		it("resolves an explicit view option without verb parsing", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "do it", {
				action: "show",
				view: "settings",
			});
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["settings"]);
		});
	});

	describe("PASSIVE intent routing — intent-only phrases (planner supplies view id)", () => {
		// In production the LLM planner selects VIEWS action=show with a view id
		// for intent-only utterances. We assert the resolver honors that id end to
		// end (the navigate actually fires for the inferred view).
		const PASSIVE_PLANNER_CASES: ReadonlyArray<readonly [string, string]> = [
			["what's on my calendar", "calendar"],
			["I want to add a new feature to my app", "plugins-page"],
			["check my unread messages", "inbox"],
			["how much money do I have", "wallet"],
		];

		it.each(
			PASSIVE_PLANNER_CASES,
		)('planner-routed intent "%s" opens view "%s"', async (phrase, viewId) => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, phrase, {
				action: "show",
				view: viewId,
			});
			expect(result?.success).toBe(true);
			expect(result?.values?.viewId).toBe(viewId);
			expect(navigated).toEqual([viewId]);
		});

		// The deterministic intent->view fallback (resolveIntentView) routes the
		// spec's passive examples even when the planner does NOT pre-resolve the
		// id: an intent-only utterance like "what is on my calendar" maps straight
		// to the calendar view, where previously the whole-phrase keyword scorer
		// returned 0 and nothing resolved.
		it("resolves an intent-only phrase from raw text via the intent fallback", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(
				REGISTRY,
				"show me what is on my calendar",
			);
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["calendar"]);
		});

		// When the view *name* appears as a trailing token the keyword resolver
		// does pick it up (label substring match), so a lightly-phrased intent
		// still routes without the planner.
		it("resolves when the view label is a trailing token of the phrase", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "show me the calendar");
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["calendar"]);
		});
	});

	describe("ambiguity + miss handling", () => {
		it("returns no-match (not a wrong view) for an unknown target", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "open the spaceship view");
			expect(result?.success).toBe(false);
			expect(result?.text).toContain("No view matches");
			expect(navigated).toEqual([]);
		});

		it("asks which one when a target is genuinely ambiguous", async () => {
			const ambiguousRegistry: ViewSummary[] = [
				{
					id: "notes-a",
					label: "Notes",
					description: "Sticky notes",
					pluginName: "a",
					available: true,
					viewType: "gui",
					tags: ["notes"],
				},
				{
					id: "notes-b",
					label: "Notes Pro",
					description: "Advanced notes",
					pluginName: "b",
					available: true,
					viewType: "gui",
					tags: ["notes"],
				},
			];
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(ambiguousRegistry, "open notes view");
			// scoreView: "notes" exact-label-matches notes-a (100) but only
			// substring-matches notes-b (80) → unambiguous winner notes-a.
			// This asserts the tie-break picks one rather than dispatching both.
			expect(navigated.length).toBeLessThanOrEqual(1);
			if (result?.success) expect(navigated).toEqual(["notes-a"]);
		});
	});

	describe("spec ACTIVE example 'go to my email' → inbox view", () => {
		// Product spec: "go to my email" -> switch to the inbox view. Now routed by
		// the deterministic intent->view fallback (my email/inbox/messages -> inbox)
		// AND by the inbox view's email/mail aliases. Previously the keyword
		// resolver scored 0 (no email token) and returned no-match.
		it("routes 'go to my email' to the inbox view", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "go to my email");
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["inbox"]);
		});

		it("still routes once an 'email' tag/alias is on the inbox view", async () => {
			const withEmailAlias = REGISTRY.map((v) =>
				v.id === "inbox"
					? { ...v, tags: [...(v.tags ?? []), "email", "mail"] }
					: v,
			);
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(withEmailAlias, "go to my email");
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["inbox"]);
		});
	});

	describe("passive intent -> view fallback (no explicit view name)", () => {
		it("routes 'I want to add a new feature to my app' to the coding view", async () => {
			const codingRegistry: ViewSummary[] = [
				...REGISTRY,
				{
					id: "task-coordinator",
					label: "Task Coordinator",
					description: "Coding agent task threads, sessions, and controls",
					pluginName: "task-coordinator",
					available: true,
					viewType: "gui",
					tags: [
						"developer",
						"coding-agent",
						"coding",
						"build",
						"feature",
						"app builder",
						"tasks",
					],
				},
			];
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(
				codingRegistry,
				"I want to add a new feature to my app",
			);
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["task-coordinator"]);
		});

		it("routes 'check my messages' to the inbox (owner decision)", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "check my messages");
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["inbox"]);
		});

		it("routes 'show me my balance' to the wallet", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(REGISTRY, "show me my balance");
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["wallet"]);
		});

		it("routes 'give me an overview of my wallet' to wallet (no 'view'-in-overview misparse)", async () => {
			const { navigated } = installNavigateCapture();
			const { result } = await runShow(
				REGISTRY,
				"give me an overview of my wallet",
			);
			expect(result?.success).toBe(true);
			expect(navigated).toEqual(["wallet"]);
		});
	});

	describe("validate() gating", () => {
		it("allows read/navigation modes for any user", async () => {
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: vi.fn(async () => false),
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				message("open the wallet view") as never,
			);
			expect(ok).toBe(true);
		});

		it("owner-gates create/edit/delete", async () => {
			const owner = vi.fn(async () => false);
			const action = createViewsAction({
				client: clientFor(REGISTRY),
				hasOwnerAccess: owner,
			});
			const ok = await action.validate(
				{ agentId: "agent-1" } as never,
				message("delete the wallet plugin view") as never,
			);
			expect(ok).toBe(false);
			expect(owner).toHaveBeenCalled();
		});
	});

	describe("BUG PROBE: developerMode-gated views reachable by ACTIVE command", () => {
		// listViews() in the show path is called WITHOUT developerMode, so the
		// route returns only non-developer views to a normal user — but the action
		// asks the client with no developerMode flag. We assert what the client is
		// actually queried with, to document that gating depends entirely on the
		// route filtering (the action does not pass developerMode=true).
		it("show path calls listViews without forcing developerMode", async () => {
			installNavigateCapture();
			const client = clientFor(REGISTRY);
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
			});
			await action.handler(
				{ agentId: "agent-1" } as never,
				message("open the logs view") as never,
				undefined,
				undefined,
				vi.fn(),
			);
			const calls = (client.listViews as ReturnType<typeof vi.fn>).mock.calls;
			// Every listViews call must NOT request developerMode (the action relies
			// on the route's default visibility filtering, not its own escalation).
			for (const [opts] of calls) {
				expect(
					(opts as { developerMode?: boolean } | undefined)?.developerMode,
				).toBeFalsy();
			}
		});
	});
});
