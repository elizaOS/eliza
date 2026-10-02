/** Plugin unload must tear down chat pre-handlers and response-handler
 * (field) evaluators, not only actions/providers/evaluators. */
import { expect, it } from "vitest";
import type { Plugin } from "../types/plugin";

/** The chat pre-handler registry is internal to the concrete runtime; the test
 * reads it directly to assert the real post-unload state, not just bookkeeping. */
type RuntimeWithPreHandlerRegistry = {
	chatPreHandlerRegistry: { list(): { id: string }[] };
};

function buildPlugin(): Plugin {
	return {
		name: "handler-teardown-fixture",
		description: "Registers one of each hot-teardown-eligible handler type",
		chatPreHandlers: [
			{
				id: "fixture-pre-handler",
				tryHandle: async () => null,
			},
		],
		responseHandlerEvaluators: [
			{
				name: "FIXTURE_RH_EVALUATOR",
				shouldRun: () => false,
				evaluate: () => undefined,
			},
		],
		responseHandlerFieldEvaluators: [
			{
				name: "fixtureField",
				description: "Fixture field evaluator for teardown coverage.",
				schema: { type: "string" },
			},
		],
	};
}

function preHandlerIds(runtime: unknown): string[] {
	return (runtime as RuntimeWithPreHandlerRegistry).chatPreHandlerRegistry
		.list()
		.map((handler) => handler.id);
}

it("unloadPlugin removes chat pre-handlers and response-handler evaluators", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown", bio: [] },
		logLevel: "fatal",
	});

	await runtime.registerPlugin(buildPlugin());

	expect(preHandlerIds(runtime)).toContain("fixture-pre-handler");
	expect(
		runtime.responseHandlerEvaluators.some(
			(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
		),
	).toBe(true);
	expect(
		runtime.responseHandlerFieldEvaluators.some(
			(evaluator) => evaluator.name === "fixtureField",
		),
	).toBe(true);

	const ownership = await runtime.unloadPlugin("handler-teardown-fixture");
	expect(ownership).not.toBeNull();

	// The bug: these three handler kinds were never captured as owned, so they
	// survived unload. After the fix the registry and both arrays are clean.
	expect(preHandlerIds(runtime)).not.toContain("fixture-pre-handler");
	expect(
		runtime.responseHandlerEvaluators.some(
			(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
		),
	).toBe(false);
	expect(
		runtime.responseHandlerFieldEvaluators.some(
			(evaluator) => evaluator.name === "fixtureField",
		),
	).toBe(false);
});

it("re-registering after unload installs fresh handler instances", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown reload", bio: [] },
		logLevel: "fatal",
	});

	await runtime.registerPlugin(buildPlugin());
	await runtime.unloadPlugin("handler-teardown-fixture");
	// A leaked registration would make this a silent duplicate-skip; a clean
	// teardown lets the fresh instances register again.
	await runtime.registerPlugin(buildPlugin());

	expect(preHandlerIds(runtime)).toContain("fixture-pre-handler");
	expect(
		runtime.responseHandlerEvaluators.filter(
			(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
		),
	).toHaveLength(1);
	expect(
		runtime.responseHandlerFieldEvaluators.filter(
			(evaluator) => evaluator.name === "fixtureField",
		),
	).toHaveLength(1);
});
