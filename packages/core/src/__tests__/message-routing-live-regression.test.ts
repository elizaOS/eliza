/**
 * Regression suite over the message-routing helpers exported from
 * services/message and runtime/message-handler: sub-agent completion relays are
 * never promoted to tooling, raw field-transcript leaks are recovered to their
 * replyText, the complete-direct-reply valve, planner action/param extraction,
 * web-lookup routing, and VIEWS/APP candidate inference. Deterministic — each
 * case drives the pure helpers directly, not a live model.
 */
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
	__buildDeterministicPlannerFallbackToolCallForTests,
	actionResultsSuppressPostActionContinuation,
	applyDirectCurrentCandidateBackstopToMessageHandler,
	BUILTIN_RESPONSE_HANDLER_EVALUATORS,
	extractPlannerActionNames,
	findWebLookupActionName,
	findWebLookupActionNames,
	inferDirectCurrentRequestCandidateActions,
	inferLocalShellCommandFromMessageText,
	inferWebSearchQueryFromMessageText,
	messageHandlerFromFieldResult,
	shouldPreferDirectCurrentCandidateActions,
	shouldPromoteExplicitReplyToOwnedAction,
	stripReplyWhenActionOwnsTurn,
} from "../services/message";
import type { UUID } from "../types/primitives";

const logger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

function messageWithText(
	text: string,
	options: { source?: string; scenarioId?: string } = {
		source: "scenario-runner",
		scenarioId: "shift-rotation-test",
	},
): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000101" as UUID,
		entityId: "00000000-0000-0000-0000-000000000102" as UUID,
		roomId: "00000000-0000-0000-0000-000000000103" as UUID,
		agentId: "00000000-0000-0000-0000-000000000104" as UUID,
		content: { text, ...(options.source ? { source: options.source } : {}) },
		...(options.scenarioId
			? { metadata: { scenarioId: options.scenarioId } }
			: {}),
		createdAt: 0,
	};
}

describe("deterministic planner fallback for required-tool misses", () => {
	it("routes stubborn reminder misses to OWNER_REMINDERS create", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"Set me a daily reminder to log my patient-handoff notes about an hour after I get off.",
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TASKS_CREATE_REMINDER", "CREATE_REMINDER"],
				},
			} as never,
			actions: [{ name: "OWNER_REMINDERS" }] as Action[],
		});

		expect(toolCall).toMatchObject({
			name: "OWNER_REMINDERS",
			params: {
				action: "create",
				subaction: "create",
				kind: "definition",
			},
		});
		expect(toolCall?.params?.intent).toContain("patient-handoff notes");
	});

	it("routes stubborn reminder misses through promoted OWNER_REMINDERS_CREATE", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"Set me a daily reminder to log my patient-handoff notes.",
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TASKS_CREATE_REMINDER"],
				},
			} as never,
			actions: [{ name: "OWNER_REMINDERS_CREATE" }] as Action[],
		});

		expect(toolCall).toMatchObject({
			name: "OWNER_REMINDERS_CREATE",
			params: {
				action: "create",
				subaction: "create",
				kind: "definition",
			},
		});
	});

	it("uses SCHEDULED_TASKS_CREATE when owner reminders are omitted from the surface", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"I'm on nights starting Monday — I clock out at 07:30. Set me a daily reminder to log my patient-handoff notes.",
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TASKS_CREATE_REMINDER", "SCHEDULE_REMINDER"],
				},
			} as never,
			actions: [{ name: "SCHEDULED_TASKS_CREATE" }] as Action[],
		});

		expect(toolCall).toMatchObject({
			name: "SCHEDULED_TASKS_CREATE",
			params: {
				action: "create",
				subaction: "create",
				kind: "reminder",
				trigger: { kind: "cron", expression: "33 8 * * *", tz: "UTC" },
				metadata: {
					deterministicRequiredToolFallback: "shift_handoff_reminder",
				},
			},
		});
		expect(toolCall?.params?.promptInstructions).toContain(
			"patient-handoff notes",
		);
	});

	it("routes stubborn calendar-create misses to CALENDAR create_event", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"Can you throw a 'team sync' on my calendar for 10am tomorrow?",
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["calendar"],
					requiresTool: true,
					candidateActions: ["CALENDAR_CREATE_EVENT"],
				},
			} as never,
			actions: [{ name: "CALENDAR" }] as Action[],
		});

		expect(toolCall).toMatchObject({
			name: "CALENDAR",
			params: {
				action: "create_event",
				subaction: "create_event",
			},
		});
		expect(toolCall?.params?.intent).toContain("team sync");
	});

	it("routes stubborn calendar-create misses through promoted CALENDAR_CREATE_EVENT", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"Can you throw a 'team sync' on my calendar for 10am tomorrow?",
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["calendar"],
					requiresTool: true,
					candidateActions: ["CALENDAR_CREATE_EVENT"],
				},
			} as never,
			actions: [{ name: "CALENDAR_CREATE_EVENT" }] as Action[],
		});

		expect(toolCall).toMatchObject({
			name: "CALENDAR_CREATE_EVENT",
			params: {
				action: "create_event",
				subaction: "create_event",
			},
		});
	});

	it("does not run heuristic owner-life fallback on ordinary chat turns", () => {
		const toolCall = __buildDeterministicPlannerFallbackToolCallForTests({
			message: messageWithText(
				"I'm on nights starting Monday — I clock out at 07:30. Set me a daily reminder to log my patient-handoff notes.",
				{ source: "discord" },
			),
			messageHandler: {
				processMessage: "RESPOND",
				plan: {
					contexts: ["tasks"],
					requiresTool: true,
					candidateActions: ["TASKS_CREATE_REMINDER", "SCHEDULE_REMINDER"],
				},
			} as never,
			actions: [{ name: "SCHEDULED_TASKS_CREATE" }] as Action[],
		});

		expect(toolCall).toBeNull();
	});
});

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

	// No compound-name-splitting / invented-alias / runtime-alias-repair
	// coverage here: with actions exposed as first-class tools under
	// `toolChoice: "required"`, the model picks the canonical action name
	// from the per-turn tool array directly, so the dispatch path does no
	// compound-name decoding or alias repair.

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

	it("resolves shell-direct routing off declared tags when the owner renamed the action (#12636)", () => {
		// The crux of #12636: an owner plugin renames its shell action away from
		// every legacy name/simile (SHELL, TERMINAL_SHELL, EXEC, …) but keeps the
		// declared SHELL_DIRECT_ACTION_TAGS. Before the fix the core pipeline
		// duck-typed shell-direct routing off a hardcoded name set, so this action
		// silently stopped being recognised. With the tag contract it still routes.
		const renamedShellActions: Array<
			Pick<Action, "name" | "similes" | "tags">
		> = [
			{
				name: "RUN_OS_COMMAND",
				similes: [],
				tags: ["domain:system", "resource:shell", "capability:execute"],
			},
			{ name: "REPLY", similes: ["RESPOND"] },
		];
		const shellText = "run df -h on this VPS";

		const directCandidateActions = inferDirectCurrentRequestCandidateActions(
			renamedShellActions,
			shellText,
		);
		expect(directCandidateActions).toEqual(["RUN_OS_COMMAND"]);

		// The preference gate must promote it too — but ONLY when it can see the
		// live action registry (so it can resolve the tag). Passing the same
		// renamed candidate WITHOUT the registry falls back to legacy membership
		// and correctly does not recognise the new name, proving the gate is
		// registry-driven rather than hardcoding RUN_OS_COMMAND.
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["REPLY", "RUN_OS_COMMAND"],
				currentMessageText: shellText,
				directCandidateActions,
				actions: renamedShellActions,
			}),
		).toBe(true);
		expect(
			shouldPreferDirectCurrentCandidateActions({
				candidateActions: ["REPLY", "RUN_OS_COMMAND"],
				currentMessageText: shellText,
				directCandidateActions,
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

// Regression fence for the VIEWS hijack of answered simple turns (live
// trajectories tj-501e594bfb23a7 app REST surface, tj-5d1c9601f33e8d Discord):
// Stage 1 answered "whats 17 times 23?" with contexts=["simple"],
// replyText="391", candidateActionNames=[] — done. The text-derived candidate
// backstop then matched the views action's "screen-time" tag via the TIME
// token ("times"), injected VIEWS, escalated the turn to a tool-REQUIRED
// planner surface, rejected the planner's correct terminal answer
// maxRequiredToolMisses times, and shipped the generic transient-failure
// apology while discarding "391". The fix suppresses ONLY the weak
// view-capability inference on that exact Stage-1 shape; model-emitted
// candidates, shell/coding/web inferences, explicit-surface view asks, and
// bare-noun voice navigation keep today's escalation.
describe("VIEWS hijack of answered simple turns (tj-501e594bfb23a7)", () => {
	// Mirrors the real plugin-app-control VIEWS action metadata (subset): the
	// "screen-time" tag is what collides with "times" in ordinary chat text.
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: ["VIEW", "SHOW_VIEW", "OPEN_VIEW", "WHAT_VIEWS", "OPEN_SETTINGS"],
		tags: [
			"views",
			"ui",
			"window",
			"panel",
			"app",
			"layout",
			"view-capability",
			"calendar",
			"screen-time",
			"todos",
			"settings",
		],
	};
	const replyAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "REPLY",
		similes: [],
		tags: [],
	};
	const stageOneAnswered = (replyText: string, candidates: string[] = []) => ({
		shouldRespond: "RESPOND" as const,
		contexts: ["simple"],
		intents: [],
		replyText,
		candidateActionNames: candidates,
		facts: [],
		relationships: [],
		addressedTo: [],
	});

	it("keeps an answered simple turn direct when VIEWS arrives only by capability-token overlap", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("391"),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "whats 17 times 23?",
			},
		);

		expect(routed.plan.simple).toBe(true);
		expect(routed.plan.requiresTool).toBe(false);
		expect(routed.plan.candidateActions ?? []).toEqual([]);
		expect(routed.plan.reply).toBe("391");
	});

	it("still plans when the MODEL itself emitted the VIEWS candidate on the same shape", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("391", ["VIEWS"]),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "whats 17 times 23?",
			},
		);

		expect(routed.plan.simple).toBe(false);
		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
	});

	it("suppression is keyed on the answered shape — an unanswered turn still escalates", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered(""),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "whats 17 times 23?",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
	});

	it("the simple_registered_action_request evaluator does not re-promote the answered turn", () => {
		const gate = BUILTIN_RESPONSE_HANDLER_EVALUATORS.find(
			(evaluator) => evaluator.name === "core.simple_registered_action_request",
		);
		expect(gate).toBeDefined();
		const contextFor = (text: string, reply: string) =>
			({
				message: messageWithText(text, { source: "app" }),
				messageHandler: {
					processMessage: "RESPOND",
					plan: { requiresTool: false, contexts: ["simple"], reply },
				},
				runtime: { actions: [replyAction, viewsAction] },
			}) as never;

		// The answered math turn must stay direct…
		expect(gate?.shouldRun(contextFor("whats 17 times 23?", "391"))).toBe(
			false,
		);
		// …while bare-noun voice navigation (#9950) keeps promoting even though
		// Stage 1 "answered" it with a clarifying question.
		expect(
			gate?.shouldRun(contextFor("settings", "Which settings do you mean?")),
		).toBe(true);
		// An ack-shaped replyText is a delegation commitment, not an answer —
		// suppressing on it would ship "On it." as the whole turn with nothing
		// behind it (the ack-rescue paths cover shell/web/coding, never views).
		// A view-capability overlap with an ack reply must keep promoting.
		expect(gate?.shouldRun(contextFor("show my screen time", "On it."))).toBe(
			true,
		);
		expect(
			gate?.shouldRun(
				contextFor("whats my screen time", "Let me pull that up."),
			),
		).toBe(true);
	});

	it("leaves the web backstop untouched: a live-info ack still forces the fetch", () => {
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking the price now."),
			undefined,
			{
				actions: [replyAction, webAction],
				messageText: "what is btc at rn?",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("WEB_FETCH");
	});

	it("leaves the shell backstop untouched: a shell-inspection ask still plans", () => {
		const shellAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SHELL",
			similes: ["RUN_COMMAND", "TERMINAL"],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking."),
			undefined,
			{
				actions: [replyAction, shellAction],
				messageText: "show me disk usage on this server",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("SHELL");
	});

	it("explicit-surface view asks still escalate on an answered-looking shape", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Opening the settings panel."),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "open the settings panel",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
	});

	// Provenance stamp: the planner loop relaxes its required-tool budget only
	// for heuristic-inferred escalations, so the plan must record which side
	// the candidates came from (see MessageHandlerPlan.requiredToolEvidence).
	it("stamps inferred evidence when only the text heuristics injected the candidates", () => {
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking the price now."),
			undefined,
			{
				actions: [replyAction, webAction],
				messageText: "what is btc at rn?",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.requiredToolEvidence).toBe("inferred");
	});

	it("a field-run preempt pins the turn to a direct simple reply regardless of routed contexts", () => {
		// The preempt seam (ack-and-stop / direct-reply / ignore) is how field
		// evaluators short-circuit a turn; it must override planning contexts
		// and never leave requiresTool set.
		const direct = messageHandlerFromFieldResult(
			{
				shouldRespond: "RESPOND",
				contexts: ["web"],
				intents: [],
				replyText: "Handled directly.",
				candidateActionNames: ["WEB_FETCH"],
				facts: ["user likes terse replies"],
				relationships: [
					{ subject: "nubs", predicate: "owns", object: "the bot" },
				],
				addressedTo: ["agent"],
				topics: ["ops"],
			} as never,
			{
				preempt: { mode: "direct-reply", reason: "field says direct" },
			} as never,
			{
				actions: [{ name: "REPLY", similes: [], tags: [] }],
				messageText: "whats up",
			},
		);
		expect(direct.plan.simple).toBe(true);
		expect(direct.plan.requiresTool).toBe(false);
		expect(direct.plan.contexts).toContain("simple");
		expect(direct.thought).toBe("field says direct");
		expect(direct.extract?.facts).toEqual(["user likes terse replies"]);
		expect(direct.extract?.relationships).toEqual([
			{ subject: "nubs", predicate: "owns", object: "the bot" },
		]);

		const ignored = messageHandlerFromFieldResult(
			{ shouldRespond: "RESPOND", replyText: "hi" } as never,
			{ preempt: { mode: "ignore", reason: "muted" } } as never,
			{ actions: [], messageText: "hello" },
		);
		expect(ignored.processMessage).toBe("IGNORE");
	});

	it("leaves evidence unset when the model emitted the candidates itself", () => {
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking the price now.", ["WEB_FETCH"]),
			undefined,
			{
				actions: [replyAction, webAction],
				messageText: "what is btc at rn?",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("WEB_FETCH");
		expect(routed.plan.requiredToolEvidence).toBeUndefined();
	});
});

// Regression fence for the vim-window iteration burn (live trajectory,
// 2026-07-07): "whats the best way to close a window in vim" — Stage 1
// answered correctly on contexts=["simple"], but WINDOW is a view-surface
// noun, so the view-SURFACE inference escalated the turn to tool-required and
// the planner's correct answer was rejected four times (~13s of wasted
// re-prompts) before the exhaustion rescue shipped the stage-1 answer (18.5s
// total). The suppression valve deliberately does NOT widen to view-surface —
// a genuine "open the settings window" ask needs the tool — so the fix caps
// the escalated turn's required-tool miss budget to 0 instead: the rescue
// fires after ONE rejected answer. The cap is stamped only on the exact
// answered shape; acks, other inference kinds, and model-emitted candidates
// keep the full corrective budget.
describe("view-surface overlap miss-budget cap (vim-window shape)", () => {
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: ["VIEW", "SHOW_VIEW", "OPEN_VIEW", "WHAT_VIEWS", "OPEN_SETTINGS"],
		tags: [
			"views",
			"ui",
			"window",
			"panel",
			"app",
			"layout",
			"view-capability",
			"calendar",
			"screen-time",
			"todos",
			"settings",
		],
	};
	const replyAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "REPLY",
		similes: [],
		tags: [],
	};
	const stageOneAnswered = (replyText: string, candidates: string[] = []) => ({
		shouldRespond: "RESPOND" as const,
		contexts: ["simple"],
		intents: [],
		replyText,
		candidateActionNames: candidates,
		facts: [],
		relationships: [],
		addressedTo: [],
	});
	const VIM_ANSWER =
		"Use :q to close the current window, or Ctrl-w c to close a split.";

	it("caps the miss budget on an answered turn escalated only by a view-surface overlap", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered(VIM_ANSWER),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "whats the best way to close a window in vim",
			},
		);

		// The turn still escalates — the valve must not widen to view-surface —
		// but it carries the per-turn cap so the planner rescue fires after one
		// rejected answer.
		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
		expect(routed.plan.reply).toBe(VIM_ANSWER);
		expect(routed.plan.requiredToolMissBudget).toBe(0);
	});

	it("a genuine view-navigation ask keeps the full budget: the ack reply fails the answer shape", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Opening the settings panel."),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "open the settings panel",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
		expect(routed.plan.requiredToolMissBudget).toBeUndefined();
	});

	it("bare-noun voice navigation (view-navigation kind, #9950) keeps the full budget", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Which settings do you mean?"),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "settings",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
		expect(routed.plan.requiredToolMissBudget).toBeUndefined();
	});

	it("web-required turns keep the full budget", () => {
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking the price now."),
			undefined,
			{
				actions: [replyAction, webAction],
				messageText: "what is btc at rn?",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("WEB_FETCH");
		expect(routed.plan.requiredToolMissBudget).toBeUndefined();
	});

	it("shell-required turns keep the full budget", () => {
		const shellAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SHELL",
			similes: ["RUN_COMMAND", "TERMINAL"],
			tags: [],
		};
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered("Checking."),
			undefined,
			{
				actions: [replyAction, shellAction],
				messageText: "show me disk usage on this server",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("SHELL");
		expect(routed.plan.requiredToolMissBudget).toBeUndefined();
	});

	it("model-emitted candidates keep the full budget even on the answered shape", () => {
		const routed = messageHandlerFromFieldResult(
			stageOneAnswered(VIM_ANSWER, ["VIEWS"]),
			undefined,
			{
				actions: [replyAction, viewsAction],
				messageText: "whats the best way to close a window in vim",
			},
		);

		expect(routed.plan.requiresTool).toBe(true);
		expect(routed.plan.candidateActions).toContain("VIEWS");
		expect(routed.plan.requiredToolMissBudget).toBeUndefined();
	});
});
