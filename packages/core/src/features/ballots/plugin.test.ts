import { describe, expect, test } from "vitest";
import { ballotsPlugin } from "./plugin";

describe("ballotsPlugin", () => {
	test("registers all five atomic ballot actions", () => {
		expect(ballotsPlugin.name).toBe("ballots");
		const actionNames = (ballotsPlugin.actions ?? []).map((a) => a.name);
		expect(actionNames).toEqual([
			"CREATE_SECRET_BALLOT",
			"DISTRIBUTE_BALLOT",
			"SUBMIT_BALLOT_VOTE",
			"TALLY_BALLOT_IF_THRESHOLD_MET",
			"EXPIRE_BALLOT",
		]);
	});

	test("does not register any services, providers, or evaluators", () => {
		expect(ballotsPlugin.services ?? []).toHaveLength(0);
		expect(ballotsPlugin.providers ?? []).toHaveLength(0);
		expect(ballotsPlugin.evaluators ?? []).toHaveLength(0);
	});

	test("each action exposes suppressPostActionContinuation", () => {
		for (const action of ballotsPlugin.actions ?? []) {
			expect(action.suppressPostActionContinuation).toBe(true);
		}
	});

	test("DISTRIBUTE_BALLOT's target parameter is restricted to 'dm'", () => {
		const distribute = (ballotsPlugin.actions ?? []).find(
			(a) => a.name === "DISTRIBUTE_BALLOT",
		);
		const targetParam = distribute?.parameters?.find(
			(p) => p.name === "target",
		);
		expect(targetParam?.schema).toMatchObject({ enum: ["dm"] });
	});
});
