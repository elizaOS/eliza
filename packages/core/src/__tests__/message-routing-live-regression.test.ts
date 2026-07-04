import { describe, expect, it, vi } from "vitest";
import { parseActionParams } from "../actions";
import type { Action, ActionResult, IAgentRuntime, Memory } from "../index";
import {
	parseMessageHandlerOutput,
	routeMessageHandlerOutput,
} from "../runtime/message-handler";
import {
	extractReplyTextFromTranscript,
	looksLikeRawFieldTranscript,
} from "../runtime/response-field-transcript";
import {
	actionResultsSuppressPostActionContinuation,
	applyDirectCurrentCandidateBackstopToMessageHandler,
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	extractPlannerActionNames,
	findWebLookupActionName,
	findWebLookupActionNames,
	inferDirectCurrentRequestCandidateActions,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	shouldPreferDirectCurrentCandidateActions,
	shouldPromoteExplicitReplyToOwnedAction,
	stripReplyWhenActionOwnsTurn,
} from "../services/message";

const logger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

describe("sub-agent completion relay — never promoted to tooling (false 'hit a snag')", () => {
	// Live regression: a coding sub-agent's completion relay echoes the original
	// task text ("[sub-agent: Build and deploy a simple dice roller web app] …
	// live at <url>"). The core.simple_registered_action_request promotion ran
	// inferDirectCurrentRequest on that text, read it as fresh coding work, and
	// promoted the turn to requiresTool — forcing a TASKS tool the relay can't
	// satisfy → required_tool_misses exhaustion → a SUCCESSFUL build reported a
	// false "hit a snag" instead of relaying the live URL. The relay is owned by
	// the sub-agent-completion evaluator and must only deliver the result.
	const gate = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
		(evaluator) => evaluator.name === "core.simple_registered_action_request",
	);
	const actions = [
		{ name: "REPLY" },
		{
			name: "TASKS",
			tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
		},
	] as unknown as Action[];
	const contextFor = (message: Memory) =>
		({
			message,
			messageHandler: {
				processMessage: "RESPOND",
				plan: { requiresTool: false, contexts: [] },
			},
			runtime: { actions },
		}) as never;
	const relayText =
		"[sub-agent: Build and deploy a simple dice roller web app] Done — it's live at https://example.test/apps/dice-roller/";

	it("does not promote a successful completion relay (metadata.subAgent)", () => {
		expect(gate).toBeDefined();
		const relay = {
			content: {
				text: relayText,
				source: "sub_agent",
				metadata: { subAgent: true },
			},
		} as unknown as Memory;
		expect(gate?.shouldRun(contextFor(relay))).toBe(false);
	});

	it("does not promote a relay identified only by source or text prefix", () => {
		const bySource = {
			content: { text: relayText, source: "acpx:sub-agent-router" },
		} as unknown as Memory;
		expect(gate?.shouldRun(contextFor(bySource))).toBe(false);
		const byPrefix = {
			content: { text: relayText, source: "discord" },
		} as unknown as Memory;
		expect(gate?.shouldRun(contextFor(byPrefix))).toBe(false);
	});

	it("still promotes a genuine fresh coding request to tooling", () => {
		const fresh = {
			content: {
				text: "Build and deploy a simple dice roller web app",
				source: "discord",
			},
		} as unknown as Memory;
		expect(gate?.shouldRun(contextFor(fresh))).toBe(true);
	});
});

describe("raw field-transcript leak — #11712 (text-mode HANDLE_RESPONSE)", () => {
	// Live regression: a cli-inference / claude-sdk warm session in text mode
	// echoed the field set back as a plain-text keyed transcript instead of JSON.
	// The multi-line replyText (embedded blank line between the URL and the
	// "built it out..." prose) broke naive segmentation, so the WHOLE raw
	// transcript fell through as the reply and was shipped verbatim to discord.
	const LEAKED = `shouldRespond: RESPOND

replyText: it's live \u2600\ufe0f https://sol.shad0w.xyz/apps/aurora/

built it out at /workspace/apps, aurora's got the modern design + interactive bits you asked for. go click around and tell me what's ugly.

contexts: simple

topics: website build, aurora

emotion: none`;

	it("parses the raw text-mode transcript to the clean replyText and routes it as a final_reply (no raw skeleton shipped)", () => {
		const parsed = parseMessageHandlerOutput(LEAKED);
		expect(parsed).not.toBeNull();
		if (parsed === null) throw new Error("expected a parsed transcript");
		// Route it exactly as the runtime would.
		const route = routeMessageHandlerOutput(parsed);
		expect(route.type).toBe("final_reply");
		if (route.type !== "final_reply") throw new Error("expected final_reply");
		// The reply is the intended replyText VALUE, not the raw transcript.
		expect(route.reply).not.toContain("shouldRespond:");
		expect(route.reply).not.toMatch(/^replyText:/m);
		expect(route.reply).toContain("https://sol.shad0w.xyz/apps/aurora/");
		expect(route.reply).toContain("\u2600\ufe0f");
		expect(route.reply).toContain("built it out at /workspace/apps");
	});

	it("the send-boundary guard extracts replyText if a raw transcript still reaches it", () => {
		expect(looksLikeRawFieldTranscript(LEAKED)).toBe(true);
		const recovered = extractReplyTextFromTranscript(LEAKED);
		expect(recovered).not.toBeNull();
		expect(recovered).not.toContain("shouldRespond:");
		expect(recovered).toContain("https://sol.shad0w.xyz/apps/aurora/");
	});

	it("leaves a normal reply untouched (guard does not false-positive)", () => {
		expect(looksLikeRawFieldTranscript("it's live, go check it out")).toBe(
			false,
		);
		expect(
			looksLikeRawFieldTranscript(
				"Here is the plan:\n1. build the page\n2. deploy it",
			),
		).toBe(false);
	});
});

describe("reply that QUOTES a field transcript — diagnosis workflow (follow-up to #11712)", () => {
	// Live regression: a user pastes a leaked `shouldRespond:/replyText:`
	// transcript into discord and asks the bot to diagnose it (this repo's own
	// daily workflow). Stage 1 answers correctly in the canonical JSON envelope;
	// the replyText is diagnostic prose that QUOTES the transcript. The
	// send-boundary guard used to fire on the quoted `replyText:` line and
	// silently replace the whole diagnosis with only the text after the QUOTED
	// marker — the actual answer was destroyed with just a logger.warn.
	const DIAGNOSIS = `the bug is in your parser — when the model emits:

shouldRespond: RESPOND

replyText: it works

the blank line inside the value is where naive blank-line segmentation breaks. terminate values only at the next known-field line.`;

	it("routes the canonical JSON envelope to final_reply and the guard leaves the quoting diagnosis intact", () => {
		const envelope = JSON.stringify({
			shouldRespond: "RESPOND",
			replyText: DIAGNOSIS,
			contexts: ["simple"],
		});
		const parsed = parseMessageHandlerOutput(envelope);
		expect(parsed).not.toBeNull();
		if (parsed === null) throw new Error("expected a parsed envelope");
		const route = routeMessageHandlerOutput(parsed);
		expect(route.type).toBe("final_reply");
		if (route.type !== "final_reply") throw new Error("expected final_reply");
		expect(route.reply).toBe(DIAGNOSIS);
		// The exact send-boundary predicate: false ⇒ the reply ships as-is
		// instead of being rewritten to extractReplyTextFromTranscript output.
		expect(looksLikeRawFieldTranscript(route.reply)).toBe(false);
		// And the rewrite the old guard performed would have destroyed the answer:
		expect(extractReplyTextFromTranscript(DIAGNOSIS)).not.toContain(
			"the bug is in your parser",
		);
	});

	it("does not claim bare quoting prose on the text-mode path (preamble survives)", () => {
		// Same diagnosis arriving as PLAIN TEXT (no JSON envelope): the transcript
		// parser must NOT claim it — claiming discards every preamble line and
		// ships only the quote's tail ("it works…"). Null falls through to the
		// tolerant plain-text reply synthesizer, which now also declines to treat
		// quoting prose as a raw transcript, so the full diagnosis ships.
		expect(parseMessageHandlerOutput(DIAGNOSIS)).toBeNull();
		expect(looksLikeRawFieldTranscript(DIAGNOSIS)).toBe(false);
	});

	it("still blocks and recovers the GENUINE leak at the send boundary (fail-closed preserved)", () => {
		const leak = `shouldRespond: RESPOND

replyText: it's live https://example.test/apps/aurora/

contexts: simple`;
		expect(looksLikeRawFieldTranscript(leak)).toBe(true);
		expect(extractReplyTextFromTranscript(leak)).toBe(
			"it's live https://example.test/apps/aurora/",
		);
	});
});

describe("plain-text backstop — complete-direct-reply valve (2026-07-01)", () => {
	// Live regression: the Stage-1 model sometimes answers in plain prose instead
	// of the structured field envelope. That path (synthesizeSimpleReplyFromPlainText)
	// runs through applyDirectCurrentCandidateBackstopToMessageHandler, which infers
	// WEB_FETCH/WEB_SEARCH candidates for almost any interrogative — so a COMPLETE
	// plain-text answer ("Your lucky number is 4291.", a solved riddle) was promoted
	// to requiresTool=true and forced through a pointless web search + a slow extra
	// planner round, while the identical answer in JSON form went direct. The valve
	// mirrors the structured path's shouldPreferCompleteDirectReply.
	const WEB_ACTIONS = [
		{ name: "REPLY" },
		{ name: "WEB_SEARCH", similes: ["SEARCH_WEB"] },
		{ name: "WEB_FETCH" },
		{ name: "TASKS" },
	] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;
	const simplePlainReply = (reply: string) => ({
		processMessage: "RESPOND" as const,
		plan: { contexts: ["simple"], reply, simple: true },
		thought: "",
	});

	it("keeps a COMPLETE plain-text answer direct instead of forcing a web search", () => {
		const out = applyDirectCurrentCandidateBackstopToMessageHandler(
			simplePlainReply("Your lucky number is 4291."),
			{
				actions: WEB_ACTIONS,
				messageText: "my lucky number is 4291. what is my lucky number?",
			},
		);
		// inference DOES tag this with WEB_FETCH/WEB_SEARCH, but the finished
		// answer + weak signals must win: stays simple, no forced tool.
		expect(out.plan.simple).not.toBe(false);
		expect(out.plan.requiresTool).not.toBe(true);
	});

	it("keeps a solved-reasoning plain-text answer direct", () => {
		const out = applyDirectCurrentCandidateBackstopToMessageHandler(
			simplePlainReply(
				"3 minutes. Each machine makes one widget in 3 minutes, so 100 machines run in parallel and still finish in 3 minutes.",
			),
			{
				actions: WEB_ACTIONS,
				messageText:
					"if 3 machines make 3 widgets in 3 minutes, how long for 100 machines to make 100 widgets?",
			},
		);
		expect(out.plan.simple).not.toBe(false);
		expect(out.plan.requiresTool).not.toBe(true);
	});

	it("still forces the tool for a live-info ACK reply (not a complete answer)", () => {
		const out = applyDirectCurrentCandidateBackstopToMessageHandler(
			simplePlainReply("Checking the current price now."),
			{
				actions: WEB_ACTIONS,
				messageText: "what is the current price of bitcoin right now?",
			},
		);
		// an ack fails looksLikeCompleteDirectReply → live-info still fetches.
		expect(out.plan.requiresTool).toBe(true);
		expect(out.plan.candidateActions?.length ?? 0).toBeGreaterThan(0);
	});

	it("forces the fetch even when the model HALLUCINATES a complete answer to a fresh ask", () => {
		// Adversarial-review hardening: the valve must never keep a
		// confident-but-unverified plain-text "answer" to an explicitly fresh
		// question — a stale price delivered confidently is worse than the extra
		// fetch. looksLikeWebSearchRequest gates the valve off for the
		// current-info + market/news/weather class.
		const out = applyDirectCurrentCandidateBackstopToMessageHandler(
			simplePlainReply(
				"Bitcoin is trading at $45,000 right now, up 2% on the day.",
			),
			{
				actions: WEB_ACTIONS,
				messageText: "what is the current price of bitcoin right now?",
			},
		);
		expect(out.plan.requiresTool).toBe(true);
		expect(out.plan.candidateActions?.length ?? 0).toBeGreaterThan(0);
	});

	it("still plans a coding-work request even with a complete-looking reply", () => {
		const out = applyDirectCurrentCandidateBackstopToMessageHandler(
			simplePlainReply(
				"I'll build a simple hello-world web page with an h1 and some basic styling for you.",
			),
			{
				actions: WEB_ACTIONS,
				messageText: "build me a simple hello-world web page",
			},
		);
		// coding work must not be short-circuited by the complete-reply valve.
		expect(out.plan.requiresTool).toBe(true);
	});
});

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

	it("surfaces BOTH web tools to the planner, WEB_FETCH first", () => {
		// The planner-surfacing path offers WEB_FETCH (a constructible live API)
		// ahead of WEB_SEARCH (open-ended discovery) so a price/weather ask is
		// fetched live inline rather than answered from a stale search result.
		expect(
			findWebLookupActionNames([{ name: "WEB_SEARCH" }, { name: "WEB_FETCH" }]),
		).toEqual(["WEB_FETCH", "WEB_SEARCH"]);
		// Only one web tool registered → exactly that one is surfaced.
		expect(findWebLookupActionNames([{ name: "WEB_SEARCH" }])).toEqual([
			"WEB_SEARCH",
		]);
		// A single action that resolves via BOTH a fetch name and a search simile
		// must surface ONCE (the searchAction !== fetchAction dedupe guard).
		expect(
			findWebLookupActionNames([
				{ name: "WEB_FETCH", similes: ["WEB_SEARCH"] },
			]),
		).toEqual(["WEB_FETCH"]);
		// No web backend → empty, so the turn is not forced toward a web tool.
		expect(findWebLookupActionNames([{ name: "SHELL" }])).toEqual([]);
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

	it("routes a coding request that mentions a market term to coding, not web-lookup", () => {
		// "build an app … bitcoin price" trips looksLikeWebSearchRequest (the market
		// term) yet is a coding task. Coding-work must be checked before web-search
		// so it routes to coding delegation, not a web lookup.
		const actions = [{ name: "TASKS" }, { name: "WEB_SEARCH" }];
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"build an app that shows the current bitcoin price",
			),
		).toEqual(["TASKS"]);
		// A pure live-info ask (no coding verb) still routes to the web lookup.
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"what is the current bitcoin price",
			),
		).toEqual(["WEB_SEARCH"]);
	});

	it("fast-paths a direct shell ask to TERMINAL_SHELL in a lean-chat runtime (follow-up to #12021)", () => {
		// PR #12021 renamed the terminal action SHELL -> TERMINAL_SHELL. In a
		// lean-chat deployment (no plugin-coding-tools) TERMINAL_SHELL is the only
		// shell action, so the SHELL_DIRECT_ACTIONS / WEAK_DIRECT_REPLY_OVERRIDE
		// allowlists must recognise it — otherwise "run df -h on this VPS" silently
		// falls through to the general planner instead of the direct shell path.
		const leanChatActions: Array<Pick<Action, "name" | "similes" | "tags">> = [
			{
				name: "TERMINAL_SHELL",
				similes: [
					"RUN_IN_TERMINAL",
					"EXECUTE_COMMAND",
					"TERMINAL",
					"RUN_SHELL",
				],
			},
			{ name: "REPLY", similes: ["RESPOND"] },
		];
		const shellText = "run df -h on this VPS";

		// Inference resolves the renamed terminal action (by canonical name — no
		// coding-tools SHELL present to win on priority).
		const directCandidateActions = inferDirectCurrentRequestCandidateActions(
			leanChatActions,
			shellText,
		);
		expect(directCandidateActions).toEqual(["TERMINAL_SHELL"]);

		// And the preference gate promotes it: without TERMINAL_SHELL in the
		// allowlists this returned false and the turn fell through to planning.
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["REPLY", "TERMINAL_SHELL"],
				currentMessageText: shellText,
				directCandidateActions,
			}),
		).toBe(true);
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
		const text = "explain how df -h checks disk space on this VPS";
		const howToRunText = "explain how to run df -h on this VPS";

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
		expect(
			inferWebSearchQueryFromMessageText(
				"what is the current status of the build?",
			),
		).toBeNull();
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

// Regression fence for PR #8446: the `core.simple_registered_action_request`
// evaluator promotes a simple reply into planning only when the current request
// matches a REGISTERED action's metadata. The view-request inference must be
// structurally anchored to a VIEWS-named or VIEW_CAPABILITY-tagged action so it
// stays inert for the overwhelming majority of agents that never load the views
// plugin — never promoting a turn into planning on keyword text alone.
describe("VIEWS request inference (PR #8446)", () => {
	const nonViewActions: Array<Pick<Action, "name" | "similes" | "tags">> = [
		{ name: "REPLY", similes: ["RESPOND"] },
		{ name: "SEND_MESSAGE" },
	];
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: [],
		tags: [],
	};

	it("is inert when no VIEWS (or VIEW_CAPABILITY) action is registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				nonViewActions,
				"open the notes panel",
			),
		).not.toContain("VIEWS");
	});

	it("promotes a view-shaped request when a VIEWS action is registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[...nonViewActions, viewsAction],
				"open the notes panel",
			),
		).toContain("VIEWS");
	});

	it("does not promote a non-view request even with a VIEWS action registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[...nonViewActions, viewsAction],
				"what is the weather today",
			),
		).not.toContain("VIEWS");
	});

	it("resolves a VIEW_CAPABILITY-tagged action by tag, not just the VIEWS name", () => {
		const capabilityAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "OPEN_DASHBOARD",
			similes: [],
			tags: ["VIEW_CAPABILITY"],
		};
		expect(
			inferDirectCurrentRequestCandidateActions(
				[...nonViewActions, capabilityAction],
				"open the dashboard window",
			),
		).toContain("OPEN_DASHBOARD");
	});
});

// Regression fence for #9950: an installed-apps request ("show me the apps")
// must surface the APP control action alongside VIEWS so the planner can
// arbitrate between the applications themselves and the apps/views page —
// previously only VIEWS was hinted and every apps ask was answered with the
// UI view catalog.
describe("APP surface request inference (#9950)", () => {
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: [],
		tags: [],
	};
	const appAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "APP",
		similes: ["LIST_APPS", "LAUNCH_APP"],
		tags: ["apps"],
	};

	it("surfaces BOTH VIEWS and APP for an installed-apps request", () => {
		const candidates = inferDirectCurrentRequestCandidateActions(
			[viewsAction, appAction],
			"show me the apps",
		);
		expect(candidates).toContain("VIEWS");
		expect(candidates).toContain("APP");
	});

	it("does not invent APP when no app-control action is registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction],
				"show me the apps",
			),
		).toEqual(["VIEWS"]);
	});

	it("does not drag APP into pure view requests", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction],
				"open the notes panel",
			),
		).toEqual(["VIEWS"]);
	});
});

// Regression fence for #9950 (voice-transcription contract): a message that is
// nothing but a bare surface name the views action itself claims via tag or
// navigation simile ("settings", "wallet") must surface VIEWS so the turn
// plans a navigation instead of dead-ending in a Stage-1 clarifying reply.
describe("bare view-name voice navigation inference (#9950)", () => {
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: ["OPEN_SETTINGS", "SHOW_WALLET"],
		tags: ["settings", "wallet", "calendar"],
	};

	it("routes a bare tag-claimed noun to VIEWS", () => {
		expect(
			inferDirectCurrentRequestCandidateActions([viewsAction], "settings"),
		).toEqual(["VIEWS"]);
		expect(
			inferDirectCurrentRequestCandidateActions([viewsAction], "wallet"),
		).toEqual(["VIEWS"]);
	});

	it("routes a bare navigation-simile noun to VIEWS", () => {
		const simileOnly: Pick<Action, "name" | "similes" | "tags"> = {
			name: "VIEWS",
			similes: ["OPEN_INBOX"],
			tags: [],
		};
		expect(
			inferDirectCurrentRequestCandidateActions([simileOnly], "inbox"),
		).toEqual(["VIEWS"]);
	});

	it("is inert for unclaimed words, multi-word messages, and generic surface words", () => {
		expect(
			inferDirectCurrentRequestCandidateActions([viewsAction], "hello"),
		).toEqual([]);
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction],
				"settings please",
			),
		).toEqual([]);
		// "views"/"view" alone stays ambiguous (list vs manager) — not promoted.
		expect(
			inferDirectCurrentRequestCandidateActions([viewsAction], "views"),
		).toEqual([]);
	});

	it("is inert when no VIEWS action is registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[{ name: "REPLY", similes: [], tags: ["settings"] }],
				"settings",
			),
		).toEqual([]);
	});
});
