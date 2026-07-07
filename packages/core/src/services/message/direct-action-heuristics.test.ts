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
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
} from "./direct-action-heuristics.ts";

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
});
