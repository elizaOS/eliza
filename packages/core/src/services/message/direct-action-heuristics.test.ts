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
	findAvailableActionName,
	findCodingDelegationActionName,
	findShellDirectActionName,
	hasActionTags,
	inferDirectCurrentRequestCandidateActions,
	inferDirectCurrentRequestCandidateInference,
	isShellDirectActionName,
	linkShareOwnText,
	looksLikeBareLinkShare,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
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
		expect(looksLikeWebSearchRequest("what is the current price of BTC")).toBe(
			true,
		);
		expect(looksLikeWebSearchRequest("hello there friend")).toBe(false);
	});

	it("respects an explicit do-not-browse negation", () => {
		expect(looksLikeWebSearchRequest("don't browse the web for this")).toBe(
			false,
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

	it("classifies the live hijack message as weak view-capability evidence", () => {
		// "whats" bypasses the instructional-question guard ("what is" does not)
		// and "times" singularizes to TIME, matching the "screen-time" tag.
		expect(
			inferDirectCurrentRequestCandidateInference(
				[viewsAction],
				"whats 17 times 23?",
			),
		).toEqual({ names: ["VIEWS"], kind: "view-capability" });
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

	it("falls back to local APP when no cloud-apps action is registered", () => {
		expect(
			inferDirectCurrentRequestCandidateActions(
				[viewsAction, appAction],
				"list my cloud apps",
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
