/**
 * Tests the direct-action heuristics — shell / web-search intent detection and
 * action-name resolution by canonical name, simile, or delegation tag. They must
 * fire on clear intent yet respect explicit negations ("don't run commands",
 * "don't browse the web"), since a false positive runs an unwanted
 * side-effecting action.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Action } from "../../types/components";
import {
	classifyExplicitContinuationTurn,
	findAvailableActionName,
	findCodingDelegationActionName,
	findShellDirectActionName,
	hasActionTags,
	inferDirectCurrentRequestCandidateActions,
	inferDirectCurrentRequestCandidateInference,
	isShellDirectActionName,
	isToolDerivedAssistantContent,
	linkShareOwnText,
	looksLikeBareLinkShare,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
	resolveExplicitContinuationRequestText,
} from "./direct-action-heuristics.ts";

/** The exact processed-content shape Discord produces for a shared link with a
 * rendered preview: raw URL, then the connector-appended embed block. */
const DISCORD_LINK_WITH_EMBED = [
	"https://claude.ai/public/artifacts/abc123",
	"Embed #1:",
	"  Title:how the agent decides to message people",
	"  Description:(none)",
].join("\n");

describe("looksLikeBareLinkShare", () => {
	it("fires on a bare URL with no commentary", () => {
		expect(looksLikeBareLinkShare("https://example.com/some/page")).toBe(true);
	});

	it("fires on a URL with a connector embed preview — preview text is derived, not instruction", () => {
		// The embed title contains workflow-ish words ("decides to message
		// people"); they must not read as user intent.
		expect(looksLikeBareLinkShare(DISCORD_LINK_WITH_EMBED)).toBe(true);
	});

	it("fires even when the embed TITLE carries a work imperative — derived text never defeats the guard", () => {
		const imperativeTitle = [
			"https://example.com/build-guide",
			"Embed #1:",
			"  Title:Build and deploy your first app",
			"  Description:A tutorial for creating projects",
		].join("\n");
		expect(looksLikeBareLinkShare(imperativeTitle)).toBe(true);
	});

	it("fires on a URL with short non-imperative commentary", () => {
		expect(looksLikeBareLinkShare("check this out https://example.com")).toBe(
			true,
		);
		expect(looksLikeBareLinkShare("https://example.com lol")).toBe(true);
		expect(looksLikeBareLinkShare("thoughts? https://example.com")).toBe(true);
	});

	it("does NOT fire when the user's own words carry a work imperative", () => {
		expect(
			looksLikeBareLinkShare(
				"build me a landing page based on this https://example.com/design",
			),
		).toBe(false);
		expect(
			looksLikeBareLinkShare("fix the bug described here https://example.com"),
		).toBe(false);
		// The imperative may live in the residue even with an embed present.
		expect(
			looksLikeBareLinkShare(
				`implement what this describes\n${DISCORD_LINK_WITH_EMBED}`,
			),
		).toBe(false);
	});

	it("does NOT fire without a URL or on substantial commentary", () => {
		expect(looksLikeBareLinkShare("tell vega to take a break")).toBe(false);
		expect(looksLikeBareLinkShare("")).toBe(false);
		const longCommentary = `${"here is a very long analysis of the situation with many words that go on ".repeat(3)}https://example.com`;
		expect(looksLikeBareLinkShare(longCommentary)).toBe(false);
	});

	it("does NOT fire on explicit work orders whose verb is absent from the old allowlist", () => {
		// These are the exact counterexamples from issue #18108. Before the fix,
		// each short residue lacked a recognized English imperative and was
		// misclassified as a bare link share — blocking TASKS delegation and
		// steering toward the passive web-read path.
		expect(
			looksLikeBareLinkShare(
				"review this PR https://github.com/elizaOS/eliza/pull/18106",
			),
		).toBe(false);
		expect(
			looksLikeBareLinkShare(
				"audit this repository https://github.com/elizaOS/eliza",
			),
		).toBe(false);
		expect(
			looksLikeBareLinkShare(
				"investigate the failure here https://example.com/run",
			),
		).toBe(false);
		// Additional verbs absent from the old allowlist that are genuine
		// coding-intent work orders, not passive shares.
		expect(
			looksLikeBareLinkShare("analyze this error https://example.com/log"),
		).toBe(false);
		expect(
			looksLikeBareLinkShare(
				"test the changes in https://github.com/elizaOS/eliza/pull/12345",
			),
		).toBe(false);
		expect(
			looksLikeBareLinkShare(
				"read through these docs https://example.com/docs",
			),
		).toBe(false);
	});

	it("does NOT fire on non-English explicit work orders", () => {
		// The old closed English verb allowlist structurally excluded every
		// non-English work order. Conservative residue detection does not
		// depend on language.
		expect(
			looksLikeBareLinkShare(
				"revisa este PR https://github.com/elizaOS/eliza/pull/12345",
			),
		).toBe(false); // Spanish: "review this PR"
		expect(
			looksLikeBareLinkShare("审计这个代码库 https://github.com/elizaOS/eliza"),
		).toBe(false); // Chinese: "audit this codebase"
		expect(
			looksLikeBareLinkShare("このバグを修正して https://example.com/issue"),
		).toBe(false); // Japanese: "fix this bug"
	});

	it("does NOT fire on multi-word work orders with a URL", () => {
		// The residue is neither empty nor a recognized conversational phrase,
		// so it must reach ordinary routing.
		expect(
			looksLikeBareLinkShare(
				"help me understand this stack trace https://example.com/trace",
			),
		).toBe(false);
		expect(
			looksLikeBareLinkShare(
				"can you check why this build failed https://example.com/ci",
			),
		).toBe(false);
	});
});

describe("linkShareOwnText", () => {
	it("keeps only the user's own words, punctuation intact", () => {
		expect(
			linkShareOwnText("does it support backups? https://example.com"),
		).toBe("does it support backups?");
		expect(linkShareOwnText("https://example.com/some/page")).toBe("");
	});

	it("drops connector embed preview text — a page title is not the user asking", () => {
		// The embed title carries a question mark that must not surface as the
		// user's own phrasing.
		const shared = [
			"https://example.com/what-is-it",
			"Embed #1:",
			"  Title:What is umbrelOS?",
			"  Description:(none)",
		].join("\n");
		expect(linkShareOwnText(shared)).toBe("");
	});
});

describe("bare link share routes to the web-read light path, never coding", () => {
	const actions = [
		{ name: "REPLY", similes: [] },
		{ name: "WEB_FETCH", similes: [] },
		{ name: "WEB_SEARCH", similes: [] },
		{ name: "TASKS", similes: [], tags: ["domain:coding"] },
	] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

	it("a shared link surfaces WEB_FETCH-first web candidates (kind web)", () => {
		const inference = inferDirectCurrentRequestCandidateInference(
			actions,
			DISCORD_LINK_WITH_EMBED,
			{
				// A coding hook that would fire on the embed's derived text must
				// not be consulted before the link-share light path.
				looksLikeCodingWorkRequest: () => false,
				findCodingDelegationActionName: () => "TASKS",
			},
		);
		expect(inference.kind).toBe("web");
		expect(inference.names).toEqual(["WEB_FETCH", "WEB_SEARCH"]);
	});

	it("an explicit build instruction with a URL still routes to coding", () => {
		const inference = inferDirectCurrentRequestCandidateInference(
			actions,
			"build me a page like this https://example.com/design",
			{
				looksLikeCodingWorkRequest: (text) => /\bbuild\b/i.test(text),
				findCodingDelegationActionName: () => "TASKS",
			},
		);
		expect(inference.kind).toBe("coding");
		expect(inference.names).toEqual(["TASKS"]);
	});

	it("work orders with unlisted verbs are NOT forced to the web-read path (issue #18108)", () => {
		// These are the exact utterances from issue #18108. Before the fix,
		// looksLikeBareLinkShare returned true for each because the verb
		// (review/audit/investigate) was absent from the old closed allowlist,
		// so inferDirectCurrentRequestCandidateInference shunted them to the
		// web-read light path before the coding hook was ever consulted.
		// After the fix, the residue is non-empty and non-conversational, so
		// looksLikeBareLinkShare returns false and inference falls through to
		// ordinary routing — where a coding hook (if present) can select TASKS.
		for (const text of [
			"review this PR https://github.com/elizaOS/eliza/pull/18106",
			"audit this repository https://github.com/elizaOS/eliza",
			"investigate the failure here https://example.com/run",
		]) {
			// Without a coding hook, the inference must NOT be "web" — proving
			// the utterance was not forced to the link-share light path.
			const inference = inferDirectCurrentRequestCandidateInference(
				actions,
				text,
				{},
			);
			expect(inference.kind).not.toBe("web");
			expect(inference.names).not.toContain("WEB_FETCH");
		}
	});

	it("a bare URL / 'thoughts?' still routes to the web-read light path (control)", () => {
		// The control: messages that ARE genuine passive link shares must
		// still be forced to the web-read path. This proves the fix did not
		// widen the routing to let passive shares reach TASKS.
		for (const text of [
			"https://example.com/some/page",
			"thoughts? https://example.com",
		]) {
			const inference = inferDirectCurrentRequestCandidateInference(
				actions,
				text,
				{},
			);
			expect(inference.kind).toBe("web");
			expect(inference.names).toEqual(["WEB_FETCH", "WEB_SEARCH"]);
		}
	});

	it("with no web backend the link share yields no forced candidate", () => {
		const inference = inferDirectCurrentRequestCandidateInference(
			[{ name: "REPLY", similes: [] }] as unknown as ReadonlyArray<
				Pick<Action, "name" | "similes" | "tags">
			>,
			DISCORD_LINK_WITH_EMBED,
			{},
		);
		expect(inference.names).toEqual([]);
	});
});

describe("looksLikeLocalShellRequest", () => {
	it("fires on local inspect-the-repo intent, not on unrelated text", () => {
		expect(looksLikeLocalShellRequest("check git status locally")).toBe(true);
		expect(
			looksLikeLocalShellRequest("show me disk usage on this server"),
		).toBe(true);
		expect(looksLikeLocalShellRequest("what's the weather like")).toBe(false);
		expect(looksLikeLocalShellRequest("")).toBe(false);
	});

	it("respects an explicit do-not-run negation", () => {
		expect(
			looksLikeLocalShellRequest("please do not run any shell commands"),
		).toBe(false);
	});
});

describe("looksLikeWebSearchRequest", () => {
	it("fires on explicit search or current-market/news intent", () => {
		expect(looksLikeWebSearchRequest("search the web for elizaOS")).toBe(true);
		expect(
			looksLikeWebSearchRequest(
				"Fetch https://httpstat.us/503 and summarize the response",
			),
		).toBe(true);
		expect(looksLikeWebSearchRequest("what is the current price of BTC")).toBe(
			true,
		);
		expect(looksLikeWebSearchRequest("hello there friend")).toBe(false);
	});

	it("respects an explicit do-not-browse negation", () => {
		for (const text of [
			"don't browse the web for this",
			"don’t ever search the web for this",
			"never, under any circumstances, google this",
		]) {
			expect(looksLikeWebSearchRequest(text)).toBe(false);
		}
		expect(
			looksLikeWebSearchRequest("never mind, search the web for elizaOS"),
		).toBe(true);
		expect(looksLikeWebSearchRequest("search the web without Google")).toBe(
			true,
		);
	});
});

describe("findAvailableActionName", () => {
	const actions = [
		{ name: "SEND_MESSAGE", similes: ["REPLY"] },
		{ name: "SEARCH", similes: [] },
	] as unknown as ReadonlyArray<Pick<Action, "name" | "similes">>;

	it("matches by canonical name or simile, else undefined", () => {
		expect(findAvailableActionName(actions, ["send_message"])).toBe(
			"SEND_MESSAGE",
		);
		expect(findAvailableActionName(actions, ["reply"])).toBe("SEND_MESSAGE");
		expect(findAvailableActionName(actions, ["nonexistent"])).toBeUndefined();
	});
});

describe("findCodingDelegationActionName", () => {
	it("prefers declared delegation tags over legacy action names", () => {
		const actions = [
			{ name: "START_CODING_TASK", similes: [], tags: [] },
			{
				name: "TASKS",
				similes: ["CREATE_TASK"],
				tags: ["domain:coding", "resource:agent-task", "capability:delegate"],
			},
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findCodingDelegationActionName(actions)).toBe("TASKS");
	});

	it("falls back to legacy similes while old plugins migrate", () => {
		const actions = [
			{ name: "TASKS", similes: ["START_CODING_TASK"], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findCodingDelegationActionName(actions)).toBe("TASKS");
	});
});

describe("hasActionTags", () => {
	it("matches declared tags case-insensitively", () => {
		expect(
			hasActionTags({ tags: ["Domain:Coding", "Capability:Delegate"] }, [
				"domain:coding",
				"capability:delegate",
			]),
		).toBe(true);
	});
});

describe("findShellDirectActionName", () => {
	it("prefers a declared shell-direct tag over the legacy name list", () => {
		// The owner renamed SHELL -> RUN_OS_COMMAND but kept the declared tags, so
		// the pipeline must still resolve it even though the new name is not in the
		// legacy fallback set. This is the whole point of the tag contract.
		const actions = [
			{
				name: "RUN_OS_COMMAND",
				similes: [],
				tags: ["domain:system", "resource:shell", "capability:execute"],
			},
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findShellDirectActionName(actions)).toBe("RUN_OS_COMMAND");
	});

	it("falls back to the legacy name/simile set while plugins migrate", () => {
		const actions = [
			{ name: "SHELL", similes: ["RUN_IN_TERMINAL", "EXEC"], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findShellDirectActionName(actions)).toBe("SHELL");
	});

	it("keeps legacy simile fallback aligned with shell-direct classification", () => {
		const actions = [
			{ name: "LOCAL_COMMAND", similes: ["RUN_IN_TERMINAL"], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findShellDirectActionName(actions)).toBe("LOCAL_COMMAND");
		expect(isShellDirectActionName("LOCAL_COMMAND", actions)).toBe(true);
	});

	it("returns undefined when no shell-direct action is exposed", () => {
		const actions = [
			{ name: "REPLY", similes: [], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(findShellDirectActionName(actions)).toBeUndefined();
	});
});

describe("isShellDirectActionName", () => {
	it("classifies a declared shell-direct action by tag, not by name", () => {
		const actions = [
			{
				name: "RUN_OS_COMMAND",
				similes: [],
				tags: ["domain:system", "resource:shell", "capability:execute"],
			},
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(isShellDirectActionName("RUN_OS_COMMAND", actions)).toBe(true);
		expect(isShellDirectActionName("REPLY", actions)).toBe(false);
	});

	it("honors the legacy name membership when no action set is supplied", () => {
		expect(isShellDirectActionName("SHELL")).toBe(true);
		expect(isShellDirectActionName("terminal_shell")).toBe(true);
		expect(isShellDirectActionName("REPLY")).toBe(false);
		expect(isShellDirectActionName("")).toBe(false);
	});

	it("does not classify a tagless renamed action off its new name alone", () => {
		// A renamed action that dropped both the legacy name AND the declared tags
		// must NOT be treated as shell-direct — the coupling is gone by design.
		const actions = [
			{ name: "RUN_OS_COMMAND", similes: [], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(isShellDirectActionName("RUN_OS_COMMAND", actions)).toBe(false);
	});
});

describe("inferDirectCurrentRequestCandidateActions shell routing", () => {
	it("routes a local shell ask to a tag-declared shell action", () => {
		const actions = [
			{ name: "REPLY", similes: [], tags: [] },
			{
				name: "RUN_OS_COMMAND",
				similes: [],
				tags: ["domain:system", "resource:shell", "capability:execute"],
			},
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"check git status locally",
			),
		).toEqual(["RUN_OS_COMMAND"]);
	});
});

describe("inferDirectCurrentRequestCandidateActions owner-goal routing", () => {
	const actions = [
		{ name: "REPLY", similes: [], tags: [] },
		{
			name: "OWNER_GOALS",
			similes: ["CREATE_SAVINGS_PLAN", "SAVINGS_GOAL"],
			tags: [],
		},
	] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

	it("routes concrete goal-write details to the registered owner goals action", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"Make it $2,000 by March 31 for the Lisbon trip, with a $175 transfer after each paycheck and a check-in if I fall behind.",
			),
		).toEqual(["OWNER_GOALS"]);
	});

	it("routes learning-goal starts, detail follow-ups, and draft confirmations to owner goals", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"I want to learn conversational Spanish as a goal.",
			),
		).toEqual(["OWNER_GOALS"]);
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"Count it if I walk around the block after lunch three times a week for the next six weeks.",
			),
		).toEqual(["OWNER_GOALS"]);
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"Let's define success as holding a 10-minute cafe-style conversation without switching to English by December 1, with four 20-minute practice blocks each week.",
			),
		).toEqual(["OWNER_GOALS"]);
		expect(
			inferDirectCurrentRequestCandidateActions(actions, "ok save that one"),
		).toEqual(["OWNER_GOALS"]);
	});

	it("does not route ordinary learning or teaching requests to owner goals", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"I want to learn React hooks",
			),
		).toEqual([]);
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"I need to learn how to fix a leaking sink",
			),
		).toEqual([]);
		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"can you teach me Spanish?",
			),
		).toEqual([]);
	});

	it("does not infer owner-goal routing when the runtime has no goals action", () => {
		const actions = [
			{ name: "REPLY", similes: [], tags: [] },
		] as unknown as ReadonlyArray<Pick<Action, "name" | "similes" | "tags">>;

		expect(
			inferDirectCurrentRequestCandidateActions(
				actions,
				"Make it $2,000 by March 31 for the Lisbon trip, with a $175 transfer after each paycheck and a check-in if I fall behind.",
			),
		).toEqual([]);
	});
});

describe("shell-direct coupling grep guard (#12636)", () => {
	it("message.ts no longer duck-types shell-direct routing off a hardcoded name Set", () => {
		// The audit item's brittle literal was a `SHELL_DIRECT_ACTIONS = new Set([...])`
		// hardcoded in the core pipeline. Prove it is gone from the executable path
		// and that routing resolves through the declared-tag helpers instead. If a
		// future edit reintroduces the literal set, this fails loudly.
		const messagePath = fileURLToPath(
			new URL("../message.ts", import.meta.url),
		);
		const src = readFileSync(messagePath, "utf8");
		expect(src).not.toContain("const SHELL_DIRECT_ACTIONS");
		expect(src).not.toContain("SHELL_DIRECT_ACTIONS.has(");
		// And it routes through the tag-aware resolver/classifier.
		expect(src).toContain("findShellDirectActionName");
		expect(src).toContain("isShellDirectActionName");
	});
});

// The inference KIND is the load-bearing signal for the answered-simple-turn
// escalation valve in services/message.ts (VIEWS hijack, tj-501e594bfb23a7):
// only "view-capability" — an incidental token overlap with a views action's
// tag/simile vocabulary — is suppressible; every stronger detector keeps its
// escalation. Fence the classification so a refactor cannot silently widen or
// narrow the valve.
describe("inferDirectCurrentRequestCandidateInference kinds", () => {
	const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "VIEWS",
		similes: ["VIEW", "SHOW_VIEW", "OPEN_VIEW", "OPEN_SETTINGS"],
		tags: [
			"views",
			"ui",
			"panel",
			"view-capability",
			"screen-time",
			"settings",
		],
	};

	it("never matches multiword capability tags on partial token overlap (#17028)", () => {
		// "times" singularizes to TIME but the "screen-time" tag is a PHRASE:
		// without SCREEN in the message it must not produce a candidate. This
		// was the live hijack — arithmetic and cadence turns routed to VIEWS.
		for (const message of [
			"whats 17 times 23?",
			"3 times a day",
			"i need to get the time for the meeting",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([viewsAction], message),
			).toEqual({ names: [], kind: null });
		}
	});

	it("still matches capability vocabulary with navigation intent", () => {
		// SCREEN is a surface noun, so the full screen-time phrase resolves on
		// the stronger view-surface leg; a plain capability tag ("calendar")
		// still resolves on the capability leg.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"get my screen time",
			),
		).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"show my settings",
			),
		).toEqual({ names: ["VIEWS"], kind: "view-capability" });
	});

	it.each([
		["dismiss the active view", "view-surface"],
		["dismiss my settings", "view-capability"],
	] as const)(
		"preserves SS operation tokens for %s",
		(message: string, kind: "view-surface" | "view-capability") => {
			expect(
				inferDirectCurrentRequestCandidateInference([viewsAction], message),
			).toEqual({ names: ["VIEWS"], kind });
		},
	);

	it("routes recurring-habit commitments to the owner routine surface, never VIEWS (#17028)", () => {
		const routinesAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "OWNER_ROUTINES",
			similes: ["HABIT", "ROUTINE", "TRACK_HABIT", "CREATE_ROUTINE"],
			tags: [],
		};
		const pushupTurn =
			"25 pushups, 3 times a day, doesnt matter when i just need to get them in";
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, routinesAction],
				pushupTurn,
			),
		).toEqual({ names: ["OWNER_ROUTINES"], kind: "owner-routines" });
		for (const message of [
			"track this habit",
			"schedule pushups every morning",
			"remind me daily to do pushups",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, routinesAction],
					message,
				),
			).toEqual({ names: ["OWNER_ROUTINES"], kind: "owner-routines" });
		}
		// Unregistered runtimes yield NO candidate — an owner mutation must not
		// degrade into the view catalog; the unresolvable-capability path
		// declines explicitly instead.
		expect(
			inferDirectCurrentRequestCandidateInference([viewsAction], pushupTurn),
		).toEqual({ names: [], kind: null });
		// Advice questions are lookups, not commitments.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, routinesAction],
				"how many times a day should i do pushups",
			),
		).toEqual({ names: [], kind: null });
	});

	it("routes possessive owner-data reads to the owner reader, never VIEWS (read-side of fead478cfa)", () => {
		const todosAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "OWNER_TODOS",
			similes: ["TODOS", "TODO_LIST"],
			tags: [],
		};
		const todosTaggedViews: Pick<Action, "name" | "similes" | "tags"> = {
			...viewsAction,
			tags: [...(viewsAction.tags ?? []), "todos"],
		};
		// The live hijack shape: a possessive read must select the reader.
		for (const message of [
			"list my personal todos",
			"what are my todos",
			"show my todo list",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[todosTaggedViews, todosAction],
					message,
				),
			).toEqual({ names: ["OWNER_TODOS"], kind: "owner-reads" });
		}
		// Lean stacks resolve the standalone todo owner (one owner per deployment).
		const pluginTodosAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "TODO",
			similes: ["TODOS"],
			tags: [],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[todosTaggedViews, pluginTodosAction],
				"list my personal todos",
			),
		).toEqual({ names: ["TODO"], kind: "owner-reads" });
		// Without any reader the read yields NO candidate — never the view
		// catalog (that fallthrough was the live "Cannot invoke get-todos" turn).
		expect(
			inferDirectCurrentRequestCandidateInference(
				[todosTaggedViews],
				"list my personal todos",
			),
		).toEqual({ names: [], kind: null });
		// Surface-noun asks stay with the navigation legs.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[todosTaggedViews, todosAction],
				"open my todos page",
			).kind,
		).not.toBe("owner-reads");
		// Mutations and completions are not reads.
		for (const message of [
			"add a todo: buy milk",
			"check off my todo buy milk",
			"mark my first todo done",
			"how should i organize my todos",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[todosTaggedViews, todosAction],
					message,
				).kind,
			).not.toBe("owner-reads");
		}
	});

	it("covers the other owner-read domains and leaves non-possessive asks alone", () => {
		const readers: Array<Pick<Action, "name" | "similes" | "tags">> = [
			{ name: "OWNER_TODOS", similes: [], tags: [] },
			{ name: "OWNER_GOALS", similes: [], tags: [] },
			{ name: "OWNER_REMINDERS", similes: [], tags: [] },
			{ name: "OWNER_ROUTINES", similes: [], tags: [] },
			{ name: "OWNER_ALARMS", similes: [], tags: [] },
			{ name: "OWNER_FINANCES", similes: [], tags: [] },
		];
		for (const [message, actionName] of [
			["list my personal todos", "OWNER_TODOS"],
			["review our shared goals", "OWNER_GOALS"],
			["what are my reminders for today", "OWNER_REMINDERS"],
			["show my habits", "OWNER_ROUTINES"],
			["check my alarms", "OWNER_ALARMS"],
			["go over my expenses this week", "OWNER_FINANCES"],
		] as const) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, ...readers],
					message,
				),
			).toEqual({ names: [actionName], kind: "owner-reads" });
		}

		// Contextual nouns outside the possessive clause cannot steal the route.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"show my reminders about goal planning",
			),
		).toEqual({ names: ["OWNER_REMINDERS"], kind: "owner-reads" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"review my goals concerning reminder planning",
			),
		).toEqual({ names: ["OWNER_GOALS"], kind: "owner-reads" });
		// The compound phrase names finance data, not the routines surface.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"what are my spending habits?",
			),
		).toEqual({ names: ["OWNER_FINANCES"], kind: "owner-reads" });
		for (const [message, actionName] of [
			["show my reminders about today's bitcoin price", "OWNER_REMINDERS"],
			["review my goals concerning the current stock market", "OWNER_GOALS"],
			["show my todos about checking the latest weather", "OWNER_TODOS"],
		] as const) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[
						viewsAction,
						...readers,
						{ name: "WEB_SEARCH", similes: [], tags: [] },
					],
					message,
				),
			).toEqual({ names: [actionName], kind: "owner-reads" });
		}

		// Multiple requested owner domains must not be silently reduced by the
		// fixed registry order; the planner can clarify or compose readers.
		for (const message of [
			"show my goals and reminders",
			"show my reminders and goals",
			"review my todos and our routines",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, ...readers],
					message,
				),
			).toEqual({ names: [], kind: null });
		}

		// Advice, negation, quotation, and metalinguistic examples mention owner
		// nouns but do not request private records.
		for (const message of [
			"tell me how to organize my todos",
			"give me advice on my finances",
			"what are good ways to organize my finances?",
			"what are effective ways to manage my todos?",
			"tell me ways to organize my reminders",
			"show me how i can organize my goals",
			"what are the best methods for tracking my spending?",
			"do not show my reminders",
			"please don't ever show my reminders",
			"dont show my reminders",
			"don’t ever show my reminders",
			"do not ever show my reminders",
			"do not, under any circumstances, show my reminders",
			"never again list my todos",
			"never, ever list my todos",
			"never please under any circumstances show my reminders",
			"what happens when I say show my reminders",
			'write a story where she says "show my goals"',
			"i can't explain 'list my todos'",
			"i'm quoting 'list my todos'",
			"i'd rephrase 'list my todos'",
			"explain the phrase show my routines",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, ...readers],
					message,
				),
			).toEqual({ names: [], kind: null });
		}
		// No possessive anchor → not an owner read (precision over recall).
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"list the reminders",
			).kind,
		).not.toBe("owner-reads");
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"what's on my todo list? i'd like to know",
			),
		).toEqual({ names: ["OWNER_TODOS"], kind: "owner-reads" });
		for (const message of [
			"'hello!' then list my todos '...world'",
			"'okay.' now show my todos '  thanks'",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, ...readers],
					message,
				),
			).toEqual({ names: ["OWNER_TODOS"], kind: "owner-reads" });
		}
		for (const message of [
			"search the web for ways to organize my finances",
			"look up advice about my finances",
			"google tips to manage my spending",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[
						viewsAction,
						...readers,
						{ name: "WEB_SEARCH", similes: [], tags: [] },
					],
					message,
				),
			).toEqual({ names: ["WEB_SEARCH"], kind: "web" });
		}
		for (const message of [
			"what are good ways to manage my current stock spending?",
			"don't show my reminders about today's bitcoin price",
			"show my goals and reminders about current stock prices",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[
						viewsAction,
						...readers,
						{ name: "WEB_SEARCH", similes: [], tags: [] },
					],
					message,
				),
			).toEqual({ names: [], kind: null });
		}
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, ...readers],
				"don't browse the web; show my reminders",
			),
		).toEqual({ names: ["OWNER_REMINDERS"], kind: "owner-reads" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				[
					viewsAction,
					...readers,
					{ name: "WEB_SEARCH", similes: [], tags: [] },
				],
				"don't show my reminders; search the web for today's bitcoin price",
			),
		).toEqual({ names: ["WEB_SEARCH"], kind: "web" });
		// The existing settings capability contract is untouched.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"show my settings",
			),
		).toEqual({ names: ["VIEWS"], kind: "view-capability" });
	});

	it("gives owner goal mutations precedence over the views goals tag (#17028)", () => {
		const goalsAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "OWNER_GOALS",
			similes: ["GOALS"],
			tags: [],
		};
		const goalsTaggedViews: Pick<Action, "name" | "similes" | "tags"> = {
			...viewsAction,
			tags: [...(viewsAction.tags ?? []), "goals"],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[goalsTaggedViews, goalsAction],
				"add a savings goal to save 500 dollars by march",
			),
		).toEqual({ names: ["OWNER_GOALS"], kind: "owner-goals" });
		// Without the goal surface, the mutation still never selects VIEWS.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[goalsTaggedViews],
				"add a savings goal to save 500 dollars by march",
			),
		).toEqual({ names: [], kind: null });
	});

	it("classifies explicit surface asks and bare-noun navigation as strong evidence", () => {
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"open the settings panel",
			),
		).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		expect(
			inferDirectCurrentRequestCandidateInference([viewsAction], "settings"),
		).toEqual({ names: ["VIEWS"], kind: "view-navigation" });
	});

	it("does not treat read-only inspection of the already-open view as navigation", () => {
		for (const message of [
			"identify the currently open view",
			"identify this open view and name two things available here",
			"tell me which current screen I have open",
			"name the active app view",
			"Reply in one concise sentence and identify the currently open view. Do not use tools or change anything.",
			"identify the current view; do not open anything",
			"which current view is open? don't switch anything",
			"name the current view and tell me what I can do here",
			"identify the current view without closing it but don't switch anything",
			"without closing the current window please don't open settings and identify the current view",
			"without hiding this panel please don't pin it then name the active view",
			"never close this window just don't switch to settings and identify the current view",
			"identify the current view without accidentally closing it",
			"name the active view and do not ever hide it",
			"Identify the current open view. Reply with the view name and exact nonce CEREBRAS-E1F-20260826-0952. Do not use tools or change anything.",
			"identify the current active view",
			"name the open panel",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([viewsAction], message),
			).toEqual({ names: [], kind: null });
		}
	});

	it.each([
		[
			"create / and / inspection-first",
			"identify the current view and add a new panel",
		],
		["read / comma / action-first", "show settings, identify the current view"],
		[
			"update / semicolon / inspection-first",
			"name the active view; change the layout",
		],
		[
			"delete / period / action-first",
			"remove this panel. identify the current view",
		],
		[
			"open / and / action-first",
			"open settings and tell me which current view is active",
		],
		[
			"open / question / inspection-first",
			"which current view is open? switch to settings",
		],
		[
			"open / embedded / inspection-first",
			"identify and open the current view",
		],
		[
			"open / current-open adjective / inspection-first",
			"identify the current open view and open settings",
		],
		[
			"close / and / inspection-first",
			"identify the current view and close it",
		],
		[
			"close / embedded / inspection-first",
			"identify and close the current view",
		],
		[
			"close / comma / action-first",
			"dismiss the active window, then name the current view",
		],
		["close / newline / inspection-first", "name the current view\nhide it"],
		[
			"layout / semicolon / action-first",
			"arrange the windows; identify the current view",
		],
		[
			"layout / then / inspection-first",
			"identify the current view, then split it right",
		],
		[
			"layout / period / action-first",
			"tile the windows. name the active view",
		],
		["pin / comma / inspection-first", "name the active panel, then pin it"],
		[
			"pin / and / action-first",
			"dock the view and identify the current panel",
		],
		[
			"adversative but / inspection-first",
			"identify the current view without closing it but switch to settings",
		],
		[
			"adversative but after semicolon / inspection-first",
			"name the active view; never hide it but split it right",
		],
		[
			"adversative but / action-first",
			"do not close this window but switch to settings, then identify the current view",
		],
		[
			"adversative however / action-first",
			"don't hide this panel; however, pin it, then name the active view",
		],
		[
			"adversative yet / inspection-first",
			"identify the current view and never close it, yet open settings",
		],
		[
			"unpunctuated without / action-first",
			"without closing the current window please open settings and identify the current view",
		],
		[
			"unpunctuated without then / action-first",
			"without hiding this panel please pin it then name the active view",
		],
		[
			"unpunctuated never / action-first",
			"never close this window just switch to settings and identify the current view",
		],
		[
			"negated inspection / open",
			"do not identify the current view just open settings",
		],
		[
			"negated inspection / switch",
			"do not name the active view just switch to settings",
		],
	] as const)(
		"preserves actionable current-view compound: %s",
		(_case, message) => {
			expect(
				inferDirectCurrentRequestCandidateInference([viewsAction], message),
			).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		},
	);

	it("routes explicit voice preference writes to SETTINGS ahead of view navigation", () => {
		const settingsAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SETTINGS",
			similes: ["UPDATE_SETTINGS", "VOICE_SETTINGS"],
			tags: [],
		};
		for (const message of [
			"In this Eliza app's voice settings, turn continuous chat on in always-on mode.",
			"Update my voice settings: set the end-of-turn silence to 1200 ms.",
			"Switch hands-free voice off",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, settingsAction],
					message,
				),
			).toEqual({ names: ["SETTINGS"], kind: "settings-write" });
		}
	});

	it("does not turn voice-setting navigation, explanations, or negations into writes", () => {
		const settingsAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SETTINGS",
			similes: ["VOICE_SETTINGS"],
			tags: [],
		};
		for (const message of [
			"How do I change my voice settings?",
			"Open my voice settings",
			"Don't change my voice settings",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([settingsAction], message),
			).toEqual({ names: [], kind: null });
		}
	});

	it("classifies shell and web detections under their own kinds", () => {
		const shellAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SHELL",
			similes: [],
			tags: [],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[shellAction],
				"show me disk usage on this server",
			),
		).toEqual({ names: ["SHELL"], kind: "shell" });
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[webAction],
				"what is btc at rn?",
			),
		).toEqual({ names: ["WEB_FETCH"], kind: "web" });
	});

	it("returns a null kind when nothing matches", () => {
		expect(
			inferDirectCurrentRequestCandidateInference([viewsAction], "hello"),
		).toEqual({ names: [], kind: null });
	});

	// Directional words (left/right/top/bottom) are not layout operations on
	// their own. When RIGHT counted as one, any live-info phrasing ending in
	// the temporal adverb "right now" (RIGHT + NOW, a layout follow-up token)
	// became a VIEWS candidate that fired BEFORE the web detector and narrowed
	// WEB_FETCH out of the planner surface. These fence the live Discord
	// failures routing to web, and the direction rule's own boundaries.
	describe("directions alone are not layout operations", () => {
		const webAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "WEB_FETCH",
			similes: [],
			tags: [],
		};
		const viewsAction: Pick<Action, "name" | "similes" | "tags"> = {
			name: "VIEWS",
			similes: ["VIEW", "SHOW_VIEW", "OPEN_VIEW", "OPEN_SETTINGS"],
			tags: [
				"views",
				"ui",
				"panel",
				"view-capability",
				"screen-time",
				"settings",
			],
		};

		it("routes live-info 'right now' questions to web, not VIEWS", () => {
			for (const message of [
				"whats btc at right now",
				"whats the weather in tokyo right now?",
				"what is the price of eth right now",
			]) {
				expect(
					inferDirectCurrentRequestCandidateInference(
						[viewsAction, webAction],
						message,
					),
				).toEqual({ names: ["WEB_FETCH"], kind: "web" });
			}
		});

		it("does not surface VIEWS for a non-question live-info ask with 'right now'", () => {
			// GET is a read-group operation token, so while RIGHT counted as a
			// layout op this satisfied the layout leg (RIGHT) + follow-up (NOW).
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"get me the btc price right now",
				),
			).toEqual({ names: ["WEB_FETCH"], kind: "web" });
		});

		it("keeps genuine layout requests with 'right now' on the views surface", () => {
			// A real layout ask carries its own operation verb and surface noun.
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"arrange the windows right now",
				),
			).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		});

		it("a direction plus an explicit surface noun still reads as a view ask", () => {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"move it to the left of the screen",
				),
			).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		});

		it("a direction plus a capability token still reads as a view ask", () => {
			// MOVE is in no operation group and "settings" is not a surface noun;
			// the direction is the only operation evidence, and the concrete
			// capability-token match keeps the detection anchored.
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"move my settings to the right",
				),
			).toEqual({ names: ["VIEWS"], kind: "view-capability" });
		});

		it("the layout follow-up leg still fires on strong layout verbs alone", () => {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"split them vertical again",
				),
			).toEqual({ names: ["VIEWS"], kind: "view-surface" });
		});

		it("a bare direction with no surface or operation stays quiet", () => {
			expect(
				inferDirectCurrentRequestCandidateInference(
					[viewsAction, webAction],
					"move it right now",
				),
			).toEqual({ names: [], kind: null });
		});
	});
});

// Regression fence: a cloud-qualified app ask ("list my cloud apps") must
// surface the cloud-apps action in the app slot, not the local APP control
// action. With only [VIEWS, APP] hinted, the planner answered cloud-apps asks
// with the installed-app list or a similarly-named cloud action —
// LIST_CLOUD_APPS was never on the surface to win.
describe("cloud-apps surface request inference", () => {
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
	const cloudAppsAction: Pick<Action, "name" | "similes" | "tags"> = {
		name: "LIST_CLOUD_APPS",
		similes: ["MY_CLOUD_APPS", "CLOUD_APPS", "MY_DEPLOYED_APPS"],
		tags: [],
	};

	it("surfaces LIST_CLOUD_APPS instead of local APP for cloud-qualified asks", () => {
		for (const message of [
			"list my cloud apps",
			"show my cloud apps",
			"what cloud apps do I have",
			"list my deployed apps",
			"show me my hosted apps",
		]) {
			expect(
				inferDirectCurrentRequestCandidateActions(
					[viewsAction, appAction, cloudAppsAction],
					message,
				),
			).toEqual(["VIEWS", "LIST_CLOUD_APPS"]);
		}
	});

	it("keeps local APP for unqualified installed-app asks", () => {
		for (const message of ["show me the apps", "list installed apps"]) {
			expect(
				inferDirectCurrentRequestCandidateActions(
					[viewsAction, appAction, cloudAppsAction],
					message,
				),
			).toEqual(["VIEWS", "APP"]);
		}
	});

	it("never degrades a cloud-qualified ask to local APP when no cloud-apps action is registered (#17363)", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction],
				"list my cloud apps",
			),
		).toEqual(["VIEWS"]);
	});

	it("keeps cloud lifecycle/mutation asks off the deterministic cloud candidate (#17363)", () => {
		for (const message of [
			"launch my cloud app",
			"delete my cloud app",
			"open the settings for my cloud app",
			"create a cloud app for my portfolio",
			"deploy my cloud app",
			"withdraw earnings from my cloud app",
		]) {
			expect(
				inferDirectCurrentRequestCandidateActions(
					[viewsAction, appAction, cloudAppsAction],
					message,
				),
			).toEqual([]);
		}
	});

	// The candidate array must be EXACTLY empty, not merely free of the cloud
	// action: narrowing the turn to [VIEWS] alone still dropped the ranked
	// WEB_SEARCH/SEND_EMAIL candidates the other clauses asked for (#17363).
	it("yields no deterministic candidate for compound/multi-tool cloud turns (#17363)", () => {
		for (const message of [
			"list my cloud apps and then deploy the first one",
			"list my cloud apps; delete the oldest one",
			"show my cloud apps. Then launch acme.",
			"list my cloud apps and also check the deploy status",
			// Verbs absent from any denylist: the structural clause split, not an
			// enumerated downstream verb, is what keeps these with the planner.
			"list my cloud apps and search the web for reviews",
			"list my cloud apps and search the web for reviews and email me the results",
			"list my cloud apps and archive the oldest one",
			"list my cloud apps and compare their traffic",
			"list my cloud apps and export them to a spreadsheet",
			"list my cloud apps, summarize their uptime",
			"list my cloud apps plus tell me what they cost",
			"show my deployed apps and draft a tweet about them",
			"what apps do I have on eliza cloud and who visited them",
			"show my hosted apps then message the team",
			"list my cloud apps as well as my calendar for today",
			"list my cloud apps while you check my email",
		]) {
			expect(
				inferDirectCurrentRequestCandidateActions(
					[viewsAction, appAction, cloudAppsAction],
					message,
				),
			).toEqual([]);
		}
	});

	// The conservative split must not swallow single-intent phrasing whose
	// conjunction joins another hosted-inventory noun phrase or a politeness
	// tail — those still deserve the deterministic cloud read.
	it("still claims single-intent cloud reads that carry a noun-phrase or politeness tail (#17363)", () => {
		for (const message of [
			"list my cloud apps and sites",
			"show me my cloud apps and my deployed sites",
			"list my cloud apps, please",
			"what apps do I have deployed on eliza cloud?",
		]) {
			expect(
				inferDirectCurrentRequestCandidateActions(
					[viewsAction, appAction, cloudAppsAction],
					message,
				),
			).toEqual(["VIEWS", "LIST_CLOUD_APPS"]);
		}
	});

	// A compound cloud turn must yield nothing even when no cloud-apps action is
	// registered: falling through to [VIEWS] is the same narrowing bug.
	it("yields no candidate for a compound cloud turn with no cloud action registered (#17363)", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction],
				"list my cloud apps and search the web for reviews",
			),
		).toEqual([]);
	});

	// Non-cloud app turns are untouched by the cloud short-circuit.
	it("leaves compound local installed-app turns on their existing path", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction, cloudAppsAction],
				"show me the apps",
			),
		).toEqual(["VIEWS", "APP"]);
	});

	it("resolves the cloud action by simile when the canonical name differs", () => {
		const renamed: Pick<Action, "name" | "similes" | "tags"> = {
			name: "SHOW_CLOUD_PORTFOLIO",
			similes: ["MY_CLOUD_APPS"],
			tags: [],
		};
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction, renamed],
				"list my cloud apps",
			),
		).toEqual(["VIEWS", "SHOW_CLOUD_PORTFOLIO"]);
	});

	it("still routes a bare view name to VIEWS with the cloud action registered", () => {
		const navViews: Pick<Action, "name" | "similes" | "tags"> = {
			name: "VIEWS",
			similes: [],
			tags: ["settings"],
		};
		expect(
			inferDirectCurrentRequestCandidateActions(
				[navViews, appAction, cloudAppsAction],
				"settings",
			),
		).toEqual(["VIEWS"]);
	});
});

describe("batch-1 matrix fixes: budget noun + scheduled-item admin (F3/F5)", () => {
	const viewsAction = {
		name: "VIEWS",
		similes: ["OPEN_VIEW"],
		tags: ["views", "ui", "finances", "app"],
	};

	it("'what is my budget?' routes to the finances reader, never VIEWS (F3, tj-a5f72b6aa95253)", () => {
		const finances = { name: "OWNER_FINANCES", similes: [], tags: [] };
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, finances],
				"what is my budget?",
			),
		).toEqual({ names: ["OWNER_FINANCES"], kind: "owner-reads" });
		// No reader registered → no candidate, never the view catalog.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"what is my budget?",
			),
		).toEqual({ names: [], kind: null });
	});

	it("routes scheduled-admin nouns to their owner with the full action set", () => {
		const appAction = {
			name: "APP",
			similes: ["LAUNCH_APP"],
			tags: ["app", "apps"],
		};
		const actions = [
			viewsAction,
			appAction,
			{ name: "OWNER_REMINDERS", similes: [], tags: [] },
			{ name: "OWNER_ALARMS", similes: [], tags: [] },
			{ name: "OWNER_ROUTINES", similes: [], tags: [] },
			{ name: "SCHEDULED_TASKS", similes: [], tags: [] },
			{ name: "CALENDAR", similes: [], tags: [] },
		];
		const cases = [
			[
				"snooze the water the ficus reminder until 6pm sunday",
				"OWNER_REMINDERS",
			],
			["reschedule my dentist reminder to friday", "OWNER_REMINDERS"],
			["snooze my 6am alarm", "OWNER_ALARMS"],
			["postpone my morning routine", "OWNER_ROUTINES"],
			["skip today's check-in", "SCHEDULED_TASKS"],
			["reschedule my follow-up", "SCHEDULED_TASKS"],
			["delete check-in task st_checkin_123", "SCHEDULED_TASKS"],
			["delete follow-up task st_followup_123", "SCHEDULED_TASKS"],
			["reschedule the scheduled task", "SCHEDULED_TASKS"],
			["delete scheduled task st_custom_123", "SCHEDULED_TASKS"],
			["snooze the task until tomorrow", "SCHEDULED_TASKS"],
			// Calendar-event mutations reach the CALENDAR surface so state is
			// read before acting — Stage-1 must never assert calendar state from
			// stale room history (live regression: "move the lunch with dana").
			["move the lunch with dana to friday 1pm instead", "CALENDAR"],
			["cancel my dentist appointment", "CALENDAR"],
			["reschedule the team meeting to 3pm", "CALENDAR"],
			["clear my calendar for tomorrow", "CALENDAR"],
			["push the dinner reservation back an hour", "CALENDAR"],
		] as const;

		for (const [message, expected] of cases) {
			expect(
				inferDirectCurrentRequestCandidateInference(actions, message),
			).toEqual({ names: [expected], kind: "owner-scheduled-admin" });
		}
	});

	it("never falls back to reminders when the scheduled-admin owner is absent", () => {
		const actions = [
			viewsAction,
			{ name: "OWNER_REMINDERS", similes: [], tags: [] },
			{ name: "OWNER_ROUTINES", similes: [], tags: [] },
			{ name: "SCHEDULED_TASKS", similes: [], tags: [] },
		];
		expect(
			inferDirectCurrentRequestCandidateInference(actions, "snooze my alarm"),
		).toEqual({ names: [], kind: null });
		expect(
			inferDirectCurrentRequestCandidateInference(
				actions.filter((action) => action.name !== "SCHEDULED_TASKS"),
				"skip today's check-in",
			),
		).toEqual({ names: [], kind: null });
	});

	it("requires Unicode-complete admin verbs and nouns while allowing punctuation", () => {
		const actions = [
			{ name: "OWNER_ALARMS", similes: [], tags: [] },
			{ name: "SCHEDULED_TASKS", similes: [], tags: [] },
		];
		expect(
			inferDirectCurrentRequestCandidateInference(
				actions,
				"snooze—my 6am alarm!",
			),
		).toEqual({ names: ["OWNER_ALARMS"], kind: "owner-scheduled-admin" });
		for (const message of [
			"skipé my alarm",
			"snooze my alarmé",
			"snooze my alarm計画",
			"snooze my alarm\u0301",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference(actions, message),
			).toEqual({ names: [], kind: null });
		}
	});

	it("keeps ambiguous task skips and nounless snooze requests unhinted", () => {
		const actions = [
			viewsAction,
			{ name: "OWNER_REMINDERS", similes: [], tags: [] },
			{ name: "SCHEDULED_TASKS", similes: [], tags: [] },
		];
		for (const message of ["skip this task", "i want to snooze for a bit"]) {
			expect(
				inferDirectCurrentRequestCandidateInference(actions, message),
			).toEqual({ names: [], kind: null });
		}
	});

	it("owner-item deletes hint the owning umbrella (F31, tj-f02205ae366226)", () => {
		const reminders = { name: "OWNER_REMINDERS", similes: [], tags: [] };
		const alarms = { name: "OWNER_ALARMS", similes: [], tags: [] };
		const todos = { name: "OWNER_TODOS", similes: [], tags: [] };
		const appAction = {
			name: "APP",
			similes: ["LAUNCH_APP"],
			tags: ["app", "apps"],
		};
		const registered = [viewsAction, appAction, reminders, alarms, todos];
		// The live F31 shapes: exact-name deletes that Stage-1 classified as
		// simple chat, producing a fictional "can't delete reminders here — dm
		// me" surface refusal with no tool exposed.
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"delete the reminder named water the ficus",
			),
		).toEqual({ names: ["OWNER_REMINDERS"], kind: "owner-scheduled-admin" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"delete both water the ficus reminders",
			),
		).toEqual({ names: ["OWNER_REMINDERS"], kind: "owner-scheduled-admin" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"cancel the call marco reminder",
			),
		).toEqual({ names: ["OWNER_REMINDERS"], kind: "owner-scheduled-admin" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"remove my dentist alarm",
			),
		).toEqual({ names: ["OWNER_ALARMS"], kind: "owner-scheduled-admin" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"delete the todo about sandpaper",
			),
		).toEqual({ names: ["OWNER_TODOS"], kind: "owner-scheduled-admin" });
		// Delete verb with no owner surface registered: yield nothing, never
		// the view/app overlap.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction],
				"delete the reminder named water the ficus",
			),
		).toEqual({ names: [], kind: null });
		// Surface-noun asks stay with navigation, and explanation requests stay
		// chat.
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"close the reminders tab",
			).kind,
		).not.toBe("owner-scheduled-admin");
		expect(
			inferDirectCurrentRequestCandidateInference(
				registered,
				"how do i delete a reminder",
			).kind,
		).not.toBe("owner-scheduled-admin");
	});

	it("work-thread lifecycle asks hint the work-thread surface (F27, tj-ee16a14fea597e)", () => {
		const workThread = { name: "WORK_THREAD", similes: [], tags: [] };
		const appAction = {
			name: "APP",
			similes: ["LAUNCH_APP"],
			tags: ["app", "apps"],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, workThread],
				"start a work thread: plan the garage cleanout",
			),
		).toEqual({ names: ["WORK_THREAD"], kind: "owner-work-thread" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, workThread],
				"resume the kitchen reno work thread",
			),
		).toEqual({ names: ["WORK_THREAD"], kind: "owner-work-thread" });
		// No work-thread surface registered: yield nothing, never the view/app
		// overlap.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction],
				"start a work thread: plan the garage cleanout",
			),
		).toEqual({ names: [], kind: null });
		// Explanations and bare mentions stay chat.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, workThread],
				"what is a work thread",
			).kind,
		).not.toBe("owner-work-thread");
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, workThread],
				"the work thread idea sounds nice",
			).kind,
		).not.toBe("owner-work-thread");
	});
	it("media-generation asks hint the generator (F35, tj-fcf8c1c21be91f)", () => {
		const generateMedia = { name: "GENERATE_MEDIA", similes: [], tags: [] };
		const appAction = {
			name: "APP",
			similes: ["LAUNCH_APP"],
			tags: ["app", "apps"],
		};
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, generateMedia],
				"make me a pixel-art castle image, 64x64 retro game vibe",
			),
		).toEqual({ names: ["GENERATE_MEDIA"], kind: "media-generation" });
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, generateMedia],
				"generate a picture of a lighthouse at dusk",
			),
		).toEqual({ names: ["GENERATE_MEDIA"], kind: "media-generation" });
		// No generator registered: no candidate, honest chat answer allowed.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction],
				"generate a picture of a lighthouse at dusk",
			),
		).toEqual({ names: [], kind: null });
		// Generation verbs without a visual-artifact noun never match.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, generateMedia],
				"create a todo: buy sandpaper",
			).kind,
		).not.toBe("media-generation");
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction, appAction, generateMedia],
				"draw up a plan for the garage",
			).kind,
		).not.toBe("media-generation");
	});
});
describe("classifyExplicitContinuationTurn", () => {
	it("classifies directive continuations", () => {
		expect(classifyExplicitContinuationTurn("finish my request")).toBe(
			"directive",
		);
		expect(classifyExplicitContinuationTurn("Finish it.")).toBe("directive");
		expect(classifyExplicitContinuationTurn("continue")).toBe("directive");
		expect(classifyExplicitContinuationTurn("ok, go ahead")).toBe("directive");
		expect(classifyExplicitContinuationTurn("yes please do it")).toBe(
			"directive",
		);
		expect(classifyExplicitContinuationTurn("keep going")).toBe("directive");
	});

	it("classifies approval continuations", () => {
		expect(classifyExplicitContinuationTurn("that is good")).toBe("approval");
		expect(classifyExplicitContinuationTurn("that's good, go ahead")).toBe(
			"approval",
		);
		expect(classifyExplicitContinuationTurn("yes")).toBe("approval");
		expect(classifyExplicitContinuationTurn("sounds good")).toBe("approval");
		expect(classifyExplicitContinuationTurn("that works")).toBe("approval");
		expect(
			classifyExplicitContinuationTurn("sure, that's great, go ahead"),
		).toBe("approval");
		expect(classifyExplicitContinuationTurn("please this is fine")).toBe(
			"approval",
		);
	});

	it("rejects ordinary chat, topic switches, and questions", () => {
		expect(classifyExplicitContinuationTurn("that is a good question")).toBe(
			null,
		);
		expect(
			classifyExplicitContinuationTurn("how tall is the eiffel tower?"),
		).toBe(null);
		expect(
			classifyExplicitContinuationTurn("finish my sandwich and tell me a joke"),
		).toBe(null);
		expect(classifyExplicitContinuationTurn("good morning")).toBe(null);
		expect(classifyExplicitContinuationTurn("is that good?")).toBe(null);
		expect(classifyExplicitContinuationTurn("")).toBe(null);
		expect(
			classifyExplicitContinuationTurn(
				"that is good but now let's talk about the weather in tokyo instead",
			),
		).toBe(null);
	});
});

describe("resolveExplicitContinuationRequestText", () => {
	const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
	const USER_ID = "00000000-0000-0000-0000-0000000000bb";
	const OTHER_USER_ID = "00000000-0000-0000-0000-0000000000cc";
	const room = (
		entries: Array<{
			id: string;
			agent?: boolean;
			entity?: string;
			text: string;
			createdAt: number;
			callbacks?: string[];
			actions?: string[];
		}>,
	) =>
		entries.map((entry) => ({
			id: entry.id,
			entityId: entry.agent ? AGENT_ID : (entry.entity ?? USER_ID),
			createdAt: entry.createdAt,
			content: {
				text: entry.text,
				...(entry.callbacks ? { actionCallbackHistory: entry.callbacks } : {}),
				...(entry.actions ? { actions: entry.actions } : {}),
			},
		}));

	it("resolves a directive continuation to the nearest prior user request", () => {
		const resolved = resolveExplicitContinuationRequestText(
			"finish my request",
			room([
				{ id: "m1", text: "track a 30 minute run for me", createdAt: 1 },
				{
					id: "m2",
					agent: true,
					text: "Want me to log it as cardio?",
					createdAt: 2,
				},
				{ id: "m3", text: "finish my request", createdAt: 3 },
			]),
			AGENT_ID,
			USER_ID,
			"m3",
		);
		expect(resolved).toBe("track a 30 minute run for me");
	});

	it("resolves an approval turn only while the agent's last reply looks pending", () => {
		const pending = resolveExplicitContinuationRequestText(
			"that is good",
			room([
				{ id: "m1", text: "run ls in my home directory", createdAt: 1 },
				{ id: "m2", agent: true, text: "On it.", createdAt: 2 },
			]),
			AGENT_ID,
			USER_ID,
		);
		expect(pending).toBe("run ls in my home directory");

		const delivered = resolveExplicitContinuationRequestText(
			"that is good",
			room([
				{ id: "m1", text: "run ls in my home directory", createdAt: 1 },
				{
					id: "m2",
					agent: true,
					text: "Here are your files: a.txt b.txt",
					createdAt: 2,
					callbacks: ["Here are your files: a.txt b.txt"],
				},
			]),
			AGENT_ID,
			USER_ID,
		);
		expect(delivered).toBe(null);
	});

	it("does not treat a short completed reply as pending approval", () => {
		const resolved = resolveExplicitContinuationRequestText(
			"that is great",
			room([
				{ id: "m1", text: "delete the temporary file", createdAt: 1 },
				{ id: "m2", agent: true, text: "Done.", createdAt: 2 },
			]),
			AGENT_ID,
			USER_ID,
		);
		expect(resolved).toBe(null);
	});

	it("does not approve a new user request against an older assistant turn", () => {
		const resolved = resolveExplicitContinuationRequestText(
			"yes",
			room([
				{ id: "m1", text: "show my files", createdAt: 1 },
				{ id: "m2", agent: true, text: "Want me to continue?", createdAt: 2 },
				{ id: "m3", text: "delete the temporary file", createdAt: 3 },
			]),
			AGENT_ID,
			USER_ID,
		);
		expect(resolved).toBe(null);
	});

	it("does not approve an assistant turn marked as tool-derived", () => {
		const resolved = resolveExplicitContinuationRequestText(
			"sounds good",
			room([
				{ id: "m1", text: "show my files", createdAt: 1 },
				{
					id: "m2",
					agent: true,
					text: "On it.",
					createdAt: 2,
					actions: ["SHELL"],
				},
			]),
			AGENT_ID,
			USER_ID,
		);
		expect(resolved).toBe(null);
	});

	it("returns null for non-continuation turns and empty history", () => {
		expect(
			resolveExplicitContinuationRequestText(
				"what's the weather in tokyo?",
				room([{ id: "m1", text: "track a run", createdAt: 1 }]),
				AGENT_ID,
				USER_ID,
			),
		).toBe(null);
		expect(
			resolveExplicitContinuationRequestText(
				"finish it",
				[],
				AGENT_ID,
				USER_ID,
			),
		).toBe(null);
	});

	it("skips prior continuation turns instead of chaining them", () => {
		const resolved = resolveExplicitContinuationRequestText(
			"finish it",
			room([
				{ id: "m1", text: "run df -h on the server", createdAt: 1 },
				{ id: "m2", agent: true, text: "Should I run it now?", createdAt: 2 },
				{ id: "m3", text: "go ahead", createdAt: 3 },
				{ id: "m4", agent: true, text: "Working on it.", createdAt: 4 },
				{ id: "m5", text: "finish it", createdAt: 5 },
			]),
			AGENT_ID,
			USER_ID,
			"m5",
		);
		expect(resolved).toBe("run df -h on the server");
	});

	it("never resolves another participant's request", () => {
		const messages = room([
			{
				id: "m1",
				entity: OTHER_USER_ID,
				text: "delete my deployment",
				createdAt: 1,
			},
			{ id: "m2", agent: true, text: "Should I delete it?", createdAt: 2 },
		]);
		expect(
			resolveExplicitContinuationRequestText(
				"go ahead",
				messages,
				AGENT_ID,
				USER_ID,
			),
		).toBe(null);
		expect(
			resolveExplicitContinuationRequestText(
				"go ahead",
				messages,
				AGENT_ID,
				OTHER_USER_ID,
			),
		).toBe("delete my deployment");
	});

	it("does not treat planner-terminal STOP as a completed tool (#20324 review)", () => {
		expect(isToolDerivedAssistantContent({ actions: ["STOP"] })).toBe(false);
		expect(isToolDerivedAssistantContent({ actions: ["REPLY"] })).toBe(false);
		expect(
			isToolDerivedAssistantContent({ actions: ["DELETE_DEPLOYMENT"] }),
		).toBe(true);
		expect(
			resolveExplicitContinuationRequestText(
				"that is good",
				room([
					{ id: "m1", text: "run ls in my home directory", createdAt: 1 },
					{
						id: "m2",
						agent: true,
						text: "On it.",
						createdAt: 2,
						actions: ["STOP"],
					},
				]),
				AGENT_ID,
				USER_ID,
			),
		).toBe("run ls in my home directory");
		expect(
			resolveExplicitContinuationRequestText(
				"that is good",
				room([
					{ id: "m1", text: "run ls in my home directory", createdAt: 1 },
					{
						id: "m2",
						agent: true,
						text: "Done.",
						createdAt: 2,
						actions: ["SHELL"],
					},
				]),
				AGENT_ID,
				USER_ID,
			),
		).toBe(null);
	});
});

describe("noun-modified budget stays a conversational fact, not a finance read", () => {
	const finances = { name: "OWNER_FINANCES", similes: [], tags: [] };

	it("'whats my keyboard budget' produces no owner-finance candidate (live group denial)", () => {
		expect(
			inferDirectCurrentRequestCandidateInference(
				[finances],
				"whats my keyboard budget",
			),
		).toEqual({ names: [], kind: null });
	});

	it("bare and finance-adjective budgets still route to the finances reader", () => {
		for (const text of [
			"what is my budget?",
			"whats my monthly budget",
			"show me my spending budget",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([finances], text),
			).toEqual({ names: ["OWNER_FINANCES"], kind: "owner-reads" });
		}
	});
});

describe("money-spend questions route to the finances reader (non-possessive)", () => {
	const finances = { name: "OWNER_FINANCES", similes: [], tags: [] };

	it("'how much did i spend this month' → OWNER_FINANCES (live goals-misroute fix)", () => {
		expect(
			inferDirectCurrentRequestCandidateInference(
				[finances],
				"how much did i spend this month",
			),
		).toEqual({ names: ["OWNER_FINANCES"], kind: "owner-reads" });
	});

	it("spend/pay/owe phrasings all route to finances", () => {
		for (const text of [
			"how much have i spent",
			"how much money did i spend this month",
			"how much do i owe",
			"what did i spend on groceries",
			"what did i pay for the car",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([finances], text),
			).toEqual({ names: ["OWNER_FINANCES"], kind: "owner-reads" });
		}
	});

	it("non-money 'spend' phrasings do not route to finances", () => {
		for (const text of [
			"i want to spend time with the kids",
			"how should i budget my spending please give advice",
			"how much time did i spend coding",
			"how much did i spend time coding",
			"what did i spend effort on",
			"what did i pay attention to",
			"how much do i owe you an apology",
			"how much did we spend on the team lunch",
			"when I say how much did I spend, what does that mean?",
			"the phrase how much did I spend is a finance question",
		]) {
			expect(
				inferDirectCurrentRequestCandidateInference([finances], text).names,
			).not.toContain("OWNER_FINANCES");
		}
	});
});
