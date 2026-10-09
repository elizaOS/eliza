/** Plugin unload must tear down chat pre-handlers and response-handler
 * (field) evaluators, not only actions/providers/evaluators. */
import { expect, it } from "vitest";
import type { Plugin } from "../src/types/plugin";

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
	// A leaked registration would make this a silent duplicate-skip that keeps
	// the stale instances live; a clean teardown lets the fresh ones register.
	const fresh = buildPlugin();
	await runtime.registerPlugin(fresh);

	expect(livePreHandler(runtime, "fixture-pre-handler")).toBe(
		fresh.chatPreHandlers?.[0],
	);
	const liveEvaluators = runtime.responseHandlerEvaluators.filter(
		(evaluator) => evaluator.name === "FIXTURE_RH_EVALUATOR",
	);
	expect(liveEvaluators).toHaveLength(1);
	expect(liveEvaluators[0]).toBe(fresh.responseHandlerEvaluators?.[0]);
	const liveFieldEvaluators = runtime.responseHandlerFieldEvaluators.filter(
		(evaluator) => evaluator.name === "fixtureField",
	);
	expect(liveFieldEvaluators).toHaveLength(1);
	expect(liveFieldEvaluators[0]).toBe(
		fresh.responseHandlerFieldEvaluators?.[0],
	);
});

type PreHandler = NonNullable<Plugin["chatPreHandlers"]>[number];

function preHandlerPlugin(name: string, handler: PreHandler): Plugin {
	return {
		name,
		description: "Same-id chat pre-handler fixture",
		chatPreHandlers: [handler],
	};
}

function livePreHandler(runtime: unknown, id: string) {
	return (runtime as RuntimeWithPreHandlerRegistry).chatPreHandlerRegistry
		.list()
		.find((handler) => handler.id === id);
}

it("a second plugin's same-id chat pre-handler never displaces or outlives the first", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown same id", bio: [] },
		logLevel: "fatal",
	});
	const first: PreHandler = {
		id: "shared-pre-handler",
		tryHandle: async () => null,
	};
	const second: PreHandler = {
		id: "shared-pre-handler",
		tryHandle: async () => null,
	};

	await runtime.registerPlugin(preHandlerPlugin("pre-handler-first", first));
	await runtime.registerPlugin(preHandlerPlugin("pre-handler-second", second));
	// Teardown cannot restore a displaced incumbent, so a plugin-boundary
	// same-id registration is first-wins, like actions/providers/evaluators.
	expect(livePreHandler(runtime, "shared-pre-handler")).toBe(first);

	await runtime.unloadPlugin("pre-handler-second");
	expect(livePreHandler(runtime, "shared-pre-handler")).toBe(first);

	await runtime.unloadPlugin("pre-handler-first");
	expect(livePreHandler(runtime, "shared-pre-handler")).toBeUndefined();
});

it("unloading a plugin whose same-name response-handler evaluators were skipped keeps the incumbent's", async () => {
	const { createInitializedRuntime } = await import("./initialized-runtime");
	const runtime = await createInitializedRuntime({
		character: { name: "Teardown same name", bio: [] },
		logLevel: "fatal",
	});
	const incumbent = buildPlugin();
	await runtime.registerPlugin(incumbent);
	// Response-handler (field) evaluator registration skips a duplicate name,
	// so the second plugin never owns the incumbent's evaluators.
	await runtime.registerPlugin({
		...buildPlugin(),
		name: "handler-teardown-duplicate",
	});
	await runtime.unloadPlugin("handler-teardown-duplicate");

	expect(runtime.responseHandlerEvaluators).toContain(
		incumbent.responseHandlerEvaluators?.[0],
	);
	expect(runtime.responseHandlerFieldEvaluators).toContain(
		incumbent.responseHandlerFieldEvaluators?.[0],
	);
});
