/**
 * Exercises async turn ownership through the real Node ESM source loader.
 * Separate processes avoid Vitest's CommonJS compatibility hiding loader failures;
 * overlapping turns cover capture, execution policy, cancellation and plugin teardown.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const sourceRoot = new URL("./", import.meta.url).href;

const probes = [
	[
		"trajectory ownership",
		`
const { runWithTrajectoryContext, getTrajectoryContext } = await source("trajectory-context.ts");
await overlap(runWithTrajectoryContext, getTrajectoryContext, [
  { trajectoryStepId: "first-step", messageId: "first-message" },
  { trajectoryStepId: "second-step", messageId: "second-message" },
]);
`,
	],
	[
		"streaming execution policy",
		`
const { runWithStreamingContext, getStreamingContext, setTurnActionConstraint,
  getTurnActionConstraint, runWithSuppressedModelStream } = await source("streaming-context.ts");
const release = Promise.withResolvers();
const turns = ["first", "second"].map(messageId => runWithStreamingContext({
  messageId, onStreamChunk: async () => undefined,
}, async () => {
  await release.promise;
  const policy = { messageId, roomId: "room", actorId: "actor", action: "MEMORY",
    operations: ["create"], disposition: "deny", reason: messageId };
  setTurnActionConstraint(policy);
  await runWithSuppressedModelStream(async () => {
    await Promise.resolve();
    assert.deepEqual(getTurnActionConstraint(policy, "create"), policy);
    assert.equal(getTurnActionConstraint({ ...policy, messageId: "other" }, "create"), undefined);
  });
  assert.equal(getStreamingContext().messageId, messageId);
}));
release.resolve();
await Promise.all(turns);
assert.equal(getStreamingContext(), undefined);
`,
	],
	[
		"stream chunk deduplication",
		`
const { runInsideModelStreamChunkDelivery, getModelStreamChunkDeliveryDepth } = await source("streaming-context.ts");
const release = Promise.withResolvers();
const delivery = runInsideModelStreamChunkDelivery(async () => {
  await release.promise;
  assert.equal(getModelStreamChunkDeliveryDepth(), 1);
  await runInsideModelStreamChunkDelivery(async () => {
    await Promise.resolve();
    assert.equal(getModelStreamChunkDeliveryDepth(), 2);
  });
  assert.equal(getModelStreamChunkDeliveryDepth(), 1);
});
assert.equal(getModelStreamChunkDeliveryDepth(), 0);
release.resolve();
await delivery;
assert.equal(getModelStreamChunkDeliveryDepth(), 0);
`,
	],
	[
		"action model routing",
		`
const { runWithActionRoutingContext, getActionRoutingContext } = await source("runtime/action-routing-context.ts");
await overlap(runWithActionRoutingContext, getActionRoutingContext, [
  { actionName: "FIRST", modelClass: "TEXT_LARGE" },
  { actionName: "SECOND", modelClass: undefined },
]);
`,
	],
	[
		"inference timing attribution",
		`
const { runWithInferenceTiming, getInferenceTimer, InferenceTurnTimer } = await source("inference-timing.ts");
await overlap(runWithInferenceTiming, getInferenceTimer, [
  new InferenceTurnTimer({ turnId: "first", label: "first" }),
  new InferenceTurnTimer({ turnId: "second", label: "second" }),
]);
`,
	],
	[
		"in-turn cancellation self-exclusion",
		`
const { TurnControllerRegistry } = await source("runtime/turn-controller.ts");
const registry = new TurnControllerRegistry();
const release = Promise.withResolvers();
const sibling = registry.runWith("room", async signal => {
  await release.promise;
  return signal.aborted;
});
const caller = registry.runWith("room", async signal => {
  await Promise.resolve();
  assert.equal(registry.abortTurn("room", "cancel sibling"), true);
  assert.equal(signal.aborted, false);
  release.resolve();
});
await caller;
assert.equal(await sibling, true);
assert.equal(registry.hasActiveTurn("room"), false);
`,
	],
	[
		"async plugin ownership and rollback",
		`
const { AgentRuntime } = await source("runtime.ts");
const runtime = new AgentRuntime({ character: { name: "context-regression" }, enableBasicCapabilities: false });
const release = Promise.withResolvers();
const makeAction = name => ({ name, description: "Isolated lifecycle probe",
  validate: async () => true, handler: async () => ({ success: true }) });
try {
  const registrations = ["FIRST", "SECOND"].map(name => runtime.registerPlugin({
    name, description: "Isolated lifecycle probe", init: async () => {
      await release.promise;
      runtime.registerAction(makeAction(name));
    },
  }));
  release.resolve();
  await Promise.all(registrations);
  await runtime.unloadPlugin("FIRST");
  assert.deepEqual(runtime.actions.map(action => action.name), ["SECOND"]);
  await runtime.unloadPlugin("SECOND");
  assert.deepEqual(runtime.actions, []);
  await assert.rejects(runtime.registerPlugin({ name: "FAILED", init: async () => {
    await Promise.resolve();
    runtime.registerAction(makeAction("FAILED"));
    throw new Error("deliberate initialization failure");
  }}), /deliberate initialization failure/);
  assert.deepEqual(runtime.actions, []);
} finally {
  await runtime.stop();
}
`,
	],
] as const;

describe("Node ESM async context consumers", () => {
	it.each(probes)(
		"preserves %s across awaits",
		async (_name, probe) => {
			await execFileAsync(
				"node",
				[
					"--conditions=eliza-source",
					"--import",
					import.meta.resolve("tsx"),
					"--input-type=module",
					"--eval",
					`
import assert from "node:assert/strict";
const source = path => import(new URL(path, ${JSON.stringify(sourceRoot)}));
async function overlap(run, active, values) {
  const release = Promise.withResolvers();
  const turns = values.map(value => run(value, async () => {
    await release.promise;
    assert.equal(active(), value);
    await assert.rejects(run(undefined, async () => {
      await Promise.resolve();
      assert.equal(active(), undefined);
      throw new Error("nested scope failure");
    }), /nested scope failure/);
    assert.equal(active(), value);
  }));
  release.resolve();
  await Promise.all(turns);
  assert.equal(active(), undefined);
}
${probe}
`,
				],
				{ timeout: 30_000, maxBuffer: 1024 * 1024 },
			);
		},
		35_000,
	);
});
