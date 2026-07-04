/**
 * Deterministic unit tests for the unified action gate (`canActionRun` /
 * `actionGateFailure`) — synthetic in-process actions, no live model or DB.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action } from "../types/components";
import type { AgentContext, RoleGateRole } from "../types/contexts";
import type { Memory } from "../types/memory";
import {
	type ActionGateContext,
	actionGateFailure,
	canActionRun,
	type GateableAction,
} from "./action-gate";
import {
	_resetActionRolePolicyCacheForTests,
	warnOnUnmatchedActionRolePolicyKeys,
} from "./action-role-policy";

/**
 * #12087 Item 9: one gate — `canActionRun` — for every exposure/execution path
 * (planner selection, sub-planner child filtering, the tool-call executor, the
 * shortcut gate). These tests pin the precedence (private → policy → contextGate
 * → roleGate) and the two divergences the audit called out: the executor's
 * private-gate enforcement and the sub-planner OR-filter that admitted a child
 * whose ACTION_ROLE_POLICY role the caller fails.
 */

function action(overrides: Partial<GateableAction> & { name: string }): Action {
	return {
		description: "",
		validate: async () => true,
		handler: async () => ({ text: "" }),
		examples: [],
		...overrides,
	} as unknown as Action;
}

const userTurn: Memory = {
	content: { text: "hi" },
} as Memory;

const autonomousTurn: Memory = {
	content: { text: "self", metadata: { isAutonomous: true } },
} as Memory;

function ctx(over: Partial<ActionGateContext> = {}): ActionGateContext {
	return {
		message: userTurn,
		userRoles: ["USER"],
		activeContexts: [],
		...over,
	};
}

afterEach(() => {
	_resetActionRolePolicyCacheForTests();
	delete process.env.ACTION_ROLE_POLICY;
});

describe("canActionRun — roleGate", () => {
	it("denies a USER an OWNER-gated action, allows an OWNER", () => {
		const owned = action({ name: "SECRETS", roleGate: { minRole: "OWNER" } });
		expect(canActionRun(owned, ctx({ userRoles: ["USER"] }))).toBe(false);
		expect(canActionRun(owned, ctx({ userRoles: ["OWNER"] }))).toBe(true);
	});

	it("a stored MEMBER (USER-tier alias) clears a minRole:USER gate", () => {
		const gated = action({ name: "NOTE", roleGate: { minRole: "USER" } });
		expect(
			canActionRun(gated, ctx({ userRoles: ["MEMBER" as RoleGateRole] })),
		).toBe(true);
	});
});

describe("canActionRun — private-action gate", () => {
	const priv = action({ name: "REFLECT", private: true });

	it("withholds a private action on a user turn but not the autonomous loop", () => {
		expect(canActionRun(priv, ctx({ message: userTurn }))).toBe(false);
		expect(canActionRun(priv, ctx({ message: autonomousTurn }))).toBe(true);
	});

	it("skipPrivateGate lets static exposure paths pass a private action", () => {
		expect(
			canActionRun(priv, ctx({ message: userTurn, skipPrivateGate: true })),
		).toBe(true);
	});

	it("returns a descriptive failure reason", () => {
		expect(actionGateFailure(priv, ctx({ message: userTurn }))).toMatch(
			/private/i,
		);
	});
});

describe("canActionRun — ACTION_ROLE_POLICY replaces the declared gate", () => {
	beforeEach(() => {
		_resetActionRolePolicyCacheForTests();
	});

	it("policy loosens: an OWNER-gated action becomes USER-reachable", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SHELL: "USER" });
		_resetActionRolePolicyCacheForTests();
		const shell = action({ name: "SHELL", roleGate: { minRole: "OWNER" } });
		expect(canActionRun(shell, ctx({ userRoles: ["USER"] }))).toBe(true);
	});

	it("policy still gates: a caller below the policy role is denied", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SHELL: "ADMIN" });
		_resetActionRolePolicyCacheForTests();
		const shell = action({ name: "SHELL", contexts: [] });
		// GUEST fails the ADMIN policy even though the action has no roleGate —
		// this is the sub-planner OR-filter bug: contextGate passing must NOT admit
		// a child whose policy role the caller fails.
		expect(canActionRun(shell, ctx({ userRoles: ["GUEST"] }))).toBe(false);
		expect(canActionRun(shell, ctx({ userRoles: ["ADMIN"] }))).toBe(true);
	});
});

describe("warnOnUnmatchedActionRolePolicyKeys (#12087 Item 19)", () => {
	it("flags policy keys matching no registered action name", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({
			SHELL: "OWNER",
			RENAMED_OLD_NAME: "USER",
		});
		_resetActionRolePolicyCacheForTests();
		const unmatched = warnOnUnmatchedActionRolePolicyKeys([
			{ name: "SHELL" },
			{ name: "REPLY", similes: ["RESPOND"] },
		]);
		expect(unmatched).toEqual(["RENAMED_OLD_NAME"]);
	});

	it("does not treat action similes as policy keys", () => {
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ RESPOND: "USER" });
		_resetActionRolePolicyCacheForTests();
		expect(
			warnOnUnmatchedActionRolePolicyKeys([
				{ name: "REPLY", similes: ["RESPOND"] },
			]),
		).toEqual(["RESPOND"]);
	});

	it("is a no-op when no policy is configured", () => {
		_resetActionRolePolicyCacheForTests();
		expect(warnOnUnmatchedActionRolePolicyKeys([{ name: "SHELL" }])).toEqual(
			[],
		);
	});
});

describe("canActionRun — contextGate", () => {
	it("denies an action whose required context is not active", () => {
		const coding = action({
			name: "FILE",
			contextGate: { contexts: ["coding" as AgentContext] },
		});
		expect(canActionRun(coding, ctx({ activeContexts: [] }))).toBe(false);
		expect(
			canActionRun(coding, ctx({ activeContexts: ["coding" as AgentContext] })),
		).toBe(true);
	});
});
