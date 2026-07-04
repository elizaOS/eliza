/**
 * Deterministic unit tests for the `ACTION_ROLE_POLICY` operator override —
 * env-var parse/cache and pure role authorization; no model or DB.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	_resetActionRolePolicyCacheForTests,
	getActionRolePolicyWarnings,
	isActionAllowedByRolePolicy,
	readActionRolePolicy,
	resolveActionRolePolicyRole,
} from "./action-role-policy.ts";

/**
 * `ACTION_ROLE_POLICY` is an operator override that decides whether a caller may
 * run a given action by role (#8801 — it gates real capabilities like SHELL /
 * BROWSER but shipped untested). A regression that mis-parses the policy, fails
 * to drop an invalid role, or admits a below-threshold caller is a privilege
 * escalation, so the parse/lookup/authorization paths are pinned here.
 */
function setPolicy(json?: string): void {
	if (json === undefined) {
		delete process.env.ACTION_ROLE_POLICY;
	} else {
		process.env.ACTION_ROLE_POLICY = json;
	}
	_resetActionRolePolicyCacheForTests();
}

afterEach(() => setPolicy(undefined));

describe("readActionRolePolicy", () => {
	it("is empty when the env var is unset", () => {
		setPolicy(undefined);
		expect(readActionRolePolicy()).toEqual({});
	});

	it("parses + normalizes roles and drops invalid ones", () => {
		setPolicy(
			JSON.stringify({ SHELL: "guest", BROWSER: "MEMBER", EVIL: "superuser" }),
		);
		// roles uppercased/normalized; the unknown "superuser" role is dropped
		expect(readActionRolePolicy()).toEqual({
			SHELL: "GUEST",
			BROWSER: "MEMBER",
		});
	});

	it("is empty for malformed JSON or a non-object", () => {
		setPolicy("not json");
		expect(readActionRolePolicy()).toEqual({});
		setPolicy("[1,2,3]");
		expect(readActionRolePolicy()).toEqual({});
	});

	it("caches the parse until explicitly reset", () => {
		setPolicy(JSON.stringify({ SHELL: "GUEST" }));
		expect(readActionRolePolicy().SHELL).toBe("GUEST");
		// change the env WITHOUT resetting → still the cached value
		process.env.ACTION_ROLE_POLICY = JSON.stringify({ SHELL: "OWNER" });
		expect(readActionRolePolicy().SHELL).toBe("GUEST");
		_resetActionRolePolicyCacheForTests();
		expect(readActionRolePolicy().SHELL).toBe("OWNER");
	});
});

describe("resolveActionRolePolicyRole", () => {
	it("resolves a string action, undefined when absent", () => {
		setPolicy(JSON.stringify({ SHELL: "GUEST" }));
		expect(resolveActionRolePolicyRole("SHELL")).toBe("GUEST");
		expect(resolveActionRolePolicyRole("UNLISTED")).toBeUndefined();
	});

	it("resolves an object action by exact name only", () => {
		setPolicy(JSON.stringify({ RUN_SHELL: "MEMBER" }));
		expect(resolveActionRolePolicyRole({ name: "RUN_SHELL" })).toBe("MEMBER");
		expect(
			resolveActionRolePolicyRole({ name: "EXEC", similes: ["RUN_SHELL"] }),
		).toBeUndefined();
		expect(
			resolveActionRolePolicyRole({ name: "EXEC", similes: ["NOPE"] }),
		).toBeUndefined();
	});
});

describe("isActionAllowedByRolePolicy (authorization)", () => {
	it("denies an action the policy does not whitelist", () => {
		setPolicy(JSON.stringify({ SHELL: "MEMBER" }));
		expect(isActionAllowedByRolePolicy("BROWSER", ["OWNER"])).toBe(false);
	});

	it("allows a whitelisted action when the caller satisfies the role", () => {
		setPolicy(JSON.stringify({ SHELL: "MEMBER" }));
		expect(isActionAllowedByRolePolicy("SHELL", ["ADMIN"])).toBe(true);
	});

	it("denies a whitelisted action when the caller is below the role", () => {
		setPolicy(JSON.stringify({ SHELL: "ADMIN" }));
		expect(isActionAllowedByRolePolicy("SHELL", ["GUEST"])).toBe(false);
		expect(isActionAllowedByRolePolicy("SHELL", undefined)).toBe(false);
	});
});

describe("getActionRolePolicyWarnings", () => {
	it("warns on unmatched exact action names", () => {
		setPolicy(JSON.stringify({ BASH: "GUEST" }));
		expect(getActionRolePolicyWarnings([{ name: "SHELL" }])).toEqual([
			{ type: "unmatched", actionName: "BASH", policyRole: "GUEST" },
		]);
	});

	it("warns when a policy entry loosens a declared gate", () => {
		setPolicy(JSON.stringify({ SHELL: "GUEST" }));
		expect(
			getActionRolePolicyWarnings([
				{ name: "SHELL", roleGate: { minRole: "OWNER" } },
			]),
		).toEqual([
			{
				type: "loosens",
				actionName: "SHELL",
				policyRole: "GUEST",
				declaredRole: "OWNER",
			},
		]);
	});

	it("does not warn when a policy entry keeps or tightens the declared gate", () => {
		setPolicy(JSON.stringify({ SHELL: "OWNER" }));
		expect(
			getActionRolePolicyWarnings([
				{
					name: "SHELL",
					contextGate: { roleGate: { minRole: "ADMIN" } },
				},
			]),
		).toEqual([]);
	});
});
