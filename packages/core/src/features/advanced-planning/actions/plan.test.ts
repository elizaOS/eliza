/**
 * Unit tests for the PLAN action's create/update/review/finalize subactions.
 * Deterministic — the handler runs against a stub runtime with no model call;
 * assertions cover the returned plan body and persistence metadata.
 */
import { describe, expect, test } from "vitest";
import { CANONICAL_SUBACTION_KEY } from "../../../actions/subaction-dispatch.ts";
import { planAction } from "./plan.ts";

function runtime() {
	return {
		agentId: "agent-1",
		actions: [],
		getService: () => null,
	};
}

function message() {
	return { entityId: "u1", roomId: "r1", content: { text: "" } };
}

async function runPlan(parameters: Record<string, unknown>) {
	return planAction.handler(runtime() as never, message() as never, undefined, {
		parameters,
	} as never);
}

describe("PLAN action", () => {
	test("creates a parameterized plan and returns the plan body", async () => {
		const result = await runPlan({
			action: "create",
			goal: "Migrate auth service",
			phaseCount: 3,
		});

		expect(result.success).toBe(true);
		expect(result.data?.[CANONICAL_SUBACTION_KEY]).toBe("create");
		expect(result.data?.phaseCount).toBe(3);
		expect(result.data?.taskCount).toBe(3);
		expect(result.data?.plan).toMatchObject({
			description: "Migrate auth service",
			status: "draft",
		});
	});

	test("updates supplied plan data with persistence metadata", async () => {
		const create = await runPlan({ action: "create", goal: "Ship dashboard" });
		const plan = create.data?.plan;

		const result = await runPlan({
			action: "update",
			plan,
			name: "Dashboard launch plan",
			notes: "Scope tightened after review",
		});

		expect(result.success).toBe(true);
		expect(result.data?.[CANONICAL_SUBACTION_KEY]).toBe("update");
		expect(result.data?.updatedPlan).toMatchObject({
			name: "Dashboard launch plan",
		});
		expect(result.data?.requiresPersistence).toBe(false);
	});

	test("reviews supplied plan structure with validation details", async () => {
		const result = await runPlan({
			action: "review",
			plan: {
				id: "plan-1",
				name: "Launch plan",
				description: "Launch the product",
				phases: [{ id: "phase-1", name: "Build", tasks: [] }],
				successCriteria: [],
			},
		});

		expect(result.success).toBe(true);
		expect(result.data?.[CANONICAL_SUBACTION_KEY]).toBe("review");
		expect(result.data?.review).toMatchObject({
			valid: false,
			phaseCount: 1,
			taskCount: 0,
		});
	});

	test("finalizes supplied plan data with review metadata", async () => {
		const create = await runPlan({ action: "create", goal: "Cut release" });
		const plan = create.data?.plan;

		const result = await runPlan({
			action: "finalize",
			plan,
			notes: "Ready for execution",
		});

		expect(result.success).toBe(true);
		expect(result.data?.[CANONICAL_SUBACTION_KEY]).toBe("finalize");
		expect(result.data?.finalizedPlan).toMatchObject({
			status: "finalized",
			finalSummary: "Ready for execution",
		});
		expect(result.data?.requiresPersistence).toBe(false);
	});
});
