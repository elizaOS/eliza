import { describe, expect, it } from "vitest";
import type { Action } from "../../types/components";
import {
	findAvailableActionName,
	findCodingDelegationActionName,
	hasActionTags,
	looksLikeLocalShellRequest,
	looksLikeWebSearchRequest,
} from "./direct-action-heuristics.ts";

/**
 * Direct-action heuristics decide whether a message should directly trigger a
 * shell / web-search action. They must fire on clear intent but respect
 * explicit negations ("don't run commands", "don't browse the web") — a false
 * positive runs an unwanted side-effecting action.
 */

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
			hasActionTags(
				{ tags: ["Domain:Coding", "Capability:Delegate"] },
				["domain:coding", "capability:delegate"],
			),
		).toBe(true);
	});
});
