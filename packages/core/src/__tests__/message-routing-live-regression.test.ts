import { describe, expect, it, vi } from "vitest";
import { parseActionParams } from "../actions";
import type { Action, ActionResult, IAgentRuntime } from "../index";
import {
	actionResultsSuppressPostActionContinuation,
	extractPlannerActionNames,
	findWebLookupActionName,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	looksLikeSelfPolicyExplanationRequest,
	shouldPreferDirectCurrentCandidateActions,
	shouldPromoteExplicitReplyToOwnedAction,
	shouldSkipDocumentProviderRescue,
	stripReplyWhenActionOwnsTurn,
	suggestOwnedActionFromMetadata,
} from "../services/message";

const logger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("live routing regressions", () => {
	it("extracts inline params from planner action strings", () => {
		const shellPlan: Record<string, unknown> = {
			actions: 'SHELL_COMMAND <params>{"command":"df -h"}</params>',
			params: {},
		};
		expect(extractPlannerActionNames(shellPlan)).toEqual(["SHELL_COMMAND"]);
		expect(parseActionParams(shellPlan.params).get("SHELL_COMMAND")).toEqual({
			command: "df -h",
		});

		const appPlan: Record<string, unknown> = {
			actions:
				'APP {"mode":"create","app":"normie-slider","intent":"build, verify, and report"}',
			params: {},
		};
		expect(extractPlannerActionNames(appPlan)).toEqual(["APP"]);
		expect(parseActionParams(appPlan.params).get("APP")).toEqual({
			mode: "create",
			app: "normie-slider",
			intent: "build, verify, and report",
		});
	});

	it("does not treat params tags inside inline JSON strings as XML wrappers", () => {
		const plan: Record<string, unknown> = {
			actions:
				'APP {"note":"literal <params, marker","intent":"build, verify"}, SHELL_COMMAND <params>{"command":"df -h"}</params>',
			params: {},
		};

		expect(extractPlannerActionNames(plan)).toEqual(["APP", "SHELL_COMMAND"]);
		const params = parseActionParams(plan.params);
		expect(params.get("APP")).toEqual({
			note: "literal <params, marker",
			intent: "build, verify",
		});
		expect(params.get("SHELL_COMMAND")).toEqual({ command: "df -h" });
	});

	it("collapses duplicate visible REPLY planner actions", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				{ actions: [], logger } as Pick<IAgentRuntime, "actions" | "logger">,
				["REPLY", "REPLY"],
			),
		).toEqual(["REPLY"]);
	});

	it("dedupes aliases against registered canonical action names", () => {
		expect(
			stripReplyWhenActionOwnsTurn(
				{
					actions: [{ name: "REPLY", similes: ["RESPOND"] }],
					logger,
				} as Pick<IAgentRuntime, "actions" | "logger">,
				["RESPOND", "REPLY"],
			),
		).toEqual(["RESPOND"]);
	});

	// Removed: tests for compound-name splitting (`LIFE.add_goal` →
	// `LIFE`), invented-action-name alias resolution (`TASKS_ADD_TODO` →
	// `OWNER_TODOS`), and runtime-alias repair. With actions exposed as
	// first-class tools + `toolChoice: "required"`, the model picks the
	// canonical action name from the per-turn tool array directly — no
	// compound-name decoding or alias repair is needed in the dispatch
	// path. `PLANNER_ACTION_ALIASES` and `splitPlannerCompoundActionName`
	// were deleted.

	it("infers safe params for explicit local shell checks", () => {
		expect(
			inferLocalShellCommandFromMessageText(
				"check disk space on this VPS with df -h",
			),
		).toBe("df -h");
		expect(
			inferLocalShellCommandFromMessageText(
				"which folder is live read-only? answer paths only. do not run commands.",
			),
		).toBeNull();
		expect(
			inferLocalShellCommandFromMessageText(
				"check git status in /home/alice/project and tell me the branch",
			),
		).toContain("git -C '/home/alice/project' status --short --branch");
		expect(
			inferLocalShellCommandFromMessageText(
				"explain how df -h checks disk space on this VPS",
			),
		).toBeNull();
		expect(
			inferLocalShellCommandFromMessageText(
				"explain how to run df -h on this VPS",
			),
		).toBeNull();
		expect(inferLocalShellCommandFromMessageText("run df -h on this VPS")).toBe(
			"df -h",
		);
	});

	it("recognizes current-info requests as web search without spawning work", () => {
		const runtime = {
			actions: [
				{
					name: "SEARCH",
					similes: ["WEB_SEARCH", "SEARCH_WEB"],
					description: "Search the web or other registered backends",
				},
			],
		} as Pick<IAgentRuntime, "actions">;

		const suggestion = suggestOwnedActionFromMetadata(runtime, {
			content: {
				text: "what is the current BTC price in USD? answer briefly.",
			},
		});

		expect(suggestion).toMatchObject({
			actionName: "SEARCH",
			reasons: ["direct:web-search"],
		});
		expect(
			inferWebSearchQueryFromMessageText(
				"what is the current BTC price in USD? answer briefly.",
			),
		).toBe("current BTC price in USD");
	});

	it("resolves web lookups to a search action and never falls back to shell", () => {
		// A real search backend satisfies the lookup (preferred over a shell).
		expect(
			findWebLookupActionName([{ name: "BRAVE_SEARCH" }, { name: "SHELL" }]),
		).toBe("BRAVE_SEARCH");
		// With only a shell available there is no web-lookup action: return
		// undefined so the model answers directly instead of force-routing a
		// live-info ask ("current price of X") to SHELL — a tool a weak planner
		// can't drive, which loops on the required-tool cap and surfaces a
		// generic failure. Genuine shell requests route via looksLikeLocalShellRequest.
		expect(findWebLookupActionName([{ name: "SHELL" }])).toBeUndefined();
		expect(findWebLookupActionName([])).toBeUndefined();
	});

	it("resolves the keyless WEB_FETCH action as a web-lookup", () => {
		// WEB_FETCH gives non-Anthropic runtimes an inline live-info capability,
		// so the router must treat it as a valid web-lookup (by canonical name).
		expect(findWebLookupActionName([{ name: "WEB_FETCH" }])).toBe("WEB_FETCH");
		// And it routes via its LOOKUP_WEB simile (a canonical lookup name) with
		// no core change even under a different canonical action name.
		const simileAction: Pick<Action, "name" | "similes"> = {
			name: "SOME_FETCH",
			similes: ["LOOKUP_WEB"],
		};
		expect(findWebLookupActionName([simileAction])).toBe("SOME_FETCH");
	});

	it("does not promote a coding/spawn request to a web-lookup (stays TASKS)", () => {
		// `looksLikeWebSearchRequest` is false and `looksLikeCodingWorkRequest`
		// is true for these, so the coding/spawn path is untouched — the planner
		// keeps TASKS_SPAWN_AGENT and the direct web-lookup preference never fires.
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["TASKS_SPAWN_AGENT"],
				currentMessageText: "spawn a coding subagent to print today's date",
				directCandidateActions: [],
			}),
		).toBe(false);
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["TASKS_SPAWN_AGENT"],
				currentMessageText: "build a tiny static app called color-pop",
				directCandidateActions: [],
			}),
		).toBe(false);
		// Even a fabricated direct WEB_FETCH cannot promote this turn: "build a
		// weather app …" is not a local-shell request, so
		// shouldPreferDirectCurrentCandidateActions early-returns false at the
		// !looksLikeLocalShellRequest guard — before the directCandidateActions
		// WEB_FETCH check is ever consulted.
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["WEB_FETCH", "TASKS_SPAWN_AGENT"],
				currentMessageText: "build a weather app that shows today's forecast",
				directCandidateActions: ["WEB_FETCH"],
			}),
		).toBe(false);
	});

	it("promotes explicit reply to direct shell/search action aliases", () => {
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "TERMINAL",
					score: 1,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
			),
		).toBe(true);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "BRAVE_SEARCH",
					score: 1,
					secondBestScore: 0,
					reasons: ["direct:web-search"],
				},
			),
		).toBe(true);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "MANAGE_ISSUES",
					score: 1,
					secondBestScore: 0,
					reasons: ["metadata:keyword-overlap"],
				},
			),
		).toBe(false);
	});

	it("does not promote explanation-only shell questions into execution", () => {
		const runtime = {
			actions: [
				{
					name: "SHELL_COMMAND",
					description: "Run local shell commands",
				},
			],
		} as Pick<IAgentRuntime, "actions">;
		const text = "explain how df -h checks disk space on this VPS";
		const howToRunText = "explain how to run df -h on this VPS";

		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: { text },
			}),
		).toBeNull();
		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: { text: howToRunText },
			}),
		).toBeNull();
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "SHELL_COMMAND",
					score: 100,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
				text,
			),
		).toBe(false);
		expect(
			shouldPromoteExplicitReplyToOwnedAction(
				{ actions: ["REPLY"] },
				{
					actionName: "SHELL_COMMAND",
					score: 100,
					secondBestScore: 0,
					reasons: ["direct:local-shell-check"],
				},
				howToRunText,
			),
		).toBe(false);
	});

	it("does not route generic current status questions to web search", () => {
		const runtime = {
			actions: [
				{
					name: "SEARCH",
					similes: ["WEB_SEARCH", "SEARCH_WEB"],
					description: "Search the web or other registered backends",
				},
			],
		} as Pick<IAgentRuntime, "actions">;

		expect(
			suggestOwnedActionFromMetadata(runtime, {
				content: {
					text: "what is the current status of the build?",
				},
			}),
		).toBeNull();
		expect(
			inferWebSearchQueryFromMessageText(
				"what is the current status of the build?",
			),
		).toBeNull();
	});

	it("does not rescue self-policy explanation questions into task actions", () => {
		expect(
			looksLikeSelfPolicyExplanationRequest({
				content: {
					text: "for a new monetized ai chat app, what workflow, example app, and sdk should you use? answer in one short sentence. do not build anything.",
				},
			}),
		).toBe(true);
	});

	it("does not skip document rescue for ordinary second-person questions", () => {
		expect(
			shouldSkipDocumentProviderRescue({
				content: {
					text: "can you explain the uploaded document?",
				},
			} as Parameters<typeof shouldSkipDocumentProviderRescue>[0]),
		).toBe(false);
	});

	it("does not skip document rescue for self-policy questions about documents", () => {
		expect(
			shouldSkipDocumentProviderRescue({
				content: {
					text: "what workflow should you use for processing documents in your knowledge base?",
				},
			} as Parameters<typeof shouldSkipDocumentProviderRescue>[0]),
		).toBe(false);
	});

	it("stops continuation when an action result blocks the turn", () => {
		expect(
			actionResultsSuppressPostActionContinuation([
				{
					success: false,
					text: "Permission denied",
					data: {
						actionName: "SHELL_COMMAND",
						terminal: { permissionDenied: true },
					},
				} as ActionResult,
			]),
		).toBe(true);
		expect(
			actionResultsSuppressPostActionContinuation([
				{ success: true, text: "done", data: { actionName: "SEARCH" } },
			] as ActionResult[]),
		).toBe(false);
	});
});
