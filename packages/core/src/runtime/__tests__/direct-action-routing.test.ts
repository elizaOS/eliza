import { describe, expect, it } from "vitest";
import {
	__resetDirectActionRoutingRulesForTests,
	getDirectActionRoutingRules,
	registerDirectActionRoutingRule,
} from "../direct-action-routing.ts";

function runtime() {
	return {} as never;
}

function rule(id: string) {
	return {
		id,
		actionNames: [`action-${id}`],
		requiredActionTags: ["read"],
		contexts: [],
		matches: () => true,
	};
}

describe("direct-action-routing", () => {
	it("registers and returns rules per runtime", () => {
		const rt = runtime();
		registerDirectActionRoutingRule(rt, rule("a"));
		registerDirectActionRoutingRule(rt, rule("b"));
		const got = getDirectActionRoutingRules(rt).map((r) => r.id);
		expect(got).toEqual(["a", "b"]);
	});

	it("replaces a rule with the same id", () => {
		const rt = runtime();
		registerDirectActionRoutingRule(rt, rule("a"));
		registerDirectActionRoutingRule(rt, { ...rule("a"), contexts: ["x"] });
		const got = getDirectActionRoutingRules(rt);
		expect(got).toHaveLength(1);
		expect(got[0].contexts).toEqual(["x"]);
	});

	it("isolates rules between runtimes", () => {
		const rt1 = runtime();
		const rt2 = runtime();
		registerDirectActionRoutingRule(rt1, rule("a"));
		expect(getDirectActionRoutingRules(rt2)).toEqual([]);
	});

	it("supports test reset", () => {
		const rt = runtime();
		registerDirectActionRoutingRule(rt, rule("a"));
		__resetDirectActionRoutingRulesForTests(rt);
		expect(getDirectActionRoutingRules(rt)).toEqual([]);
	});
});
