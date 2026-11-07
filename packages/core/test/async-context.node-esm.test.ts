/**
 * Exercises async turn ownership through the real Node ESM source loader.
 * Separate processes avoid Vitest's CommonJS compatibility hiding loader failures;
 * overlapping turns cover capture, execution policy, cancellation and plugin teardown.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "vitest";

const execFileAsync = promisify(execFile);
const sourceRoot = new URL("../src/", import.meta.url).href;

const probes = [
	[
		"bounded model trial and physical retry ownership",
		`
const { createModelAttemptAllowance, runWithStreamingContext, getModelAttemptLease } = await source("streaming-context.ts");
const { createPreparedModelRequestGuard } = await source("runtime/prepared-model-request.ts");
const stop = new AbortController();
const options = { signal: stop.signal, budgetMicroUsd: 12, maxAttempts: 3, maxOutputTokens: 10, expiresAt: Date.now()+60000,
 tariffs: [{provider:"openai-compatible",model:"fixture",route:"http://localhost:1/v1",inputNanoUsdPerToken:100,outputNanoUsdPerToken:100,inputTokenUpperBound:30}] };
const trial = createModelAttemptAllowance(options);
const turn = new AbortController();
const lease = trial.openTurn("turn-1",turn.signal);
const request = {messages:[{role:"user",content:"Hi"}]};
const guardFor = (extra={}) => createPreparedModelRequestGuard({provider:"openai-compatible",model:"fixture",route:"http://localhost:1/v1",serializeRequest:()=>"full-text-request",outputReserveTokens:10,...extra});
assert.throws(()=>runWithStreamingContext({messageId:"turn-1",modelAttemptLease:lease},()=>guardFor()),/Invalid model/);
await runWithStreamingContext({messageId:"turn-1",modelAttemptTurnId:"turn-1",modelAttemptLease:lease,abortSignal:turn.signal}, async()=> {
 const guard = guardFor();
 await runWithStreamingContext(undefined, async()=> {
  assert.equal(getModelAttemptLease(),lease);
  const results = await Promise.allSettled(Array.from({length:4},async()=>guard.assertBeforeAttempt()));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,3);
  assert.equal(trial.remainingMicroUsd,0);
 });
 assert.throws(()=>runWithStreamingContext({messageId:"other"},()=>guardFor()),/cannot change identity/);
 assert.throws(()=>runWithStreamingContext({messageId:"assistant",modelAttemptTurnId:"foreign"},()=>guardFor()),/cannot change identity/);
 await runWithStreamingContext({messageId:"assistant",modelAttemptTurnId:"turn-1"},async()=>assert.equal(getModelAttemptLease(),lease));
 assert.throws(()=>guardFor({route:"http://foreign.invalid"}).assertBeforeAttempt(),/Unqualified/);
 assert.throws(()=>guardFor({outputReserveTokens:undefined}).assertBeforeAttempt(),/Unqualified/);
});
lease.close();
await runWithStreamingContext({messageId:"turn-1",modelAttemptTurnId:"turn-1",modelAttemptLease:lease},async()=>assert.throws(()=>guardFor().assertBeforeAttempt(),/ended/));
const next = trial.openTurn("turn-2",new AbortController().signal);
await runWithStreamingContext({messageId:"turn-2",modelAttemptTurnId:"turn-2",modelAttemptLease:next},async()=>assert.throws(()=>guardFor().assertBeforeAttempt(),/exhausted/));
next.close(); stop.abort();
assert.throws(()=>trial.openTurn("turn-3",new AbortController().signal),/ended/);
assert.throws(()=>runWithStreamingContext({messageId:"forged",modelAttemptLease:{messageId:"forged",maxOutputTokens:10000,reserve(){}}},()=>guardFor()),/Invalid model/);
const legacy = guardFor({route:undefined,outputReserveTokens:undefined}); legacy.assertBeforeAttempt(); legacy.assertBeforeAttempt();
const end = new AbortController();
const activeTrial = createModelAttemptAllowance({...options,signal:end.signal,budgetMicroUsd:100});
const activeLease = activeTrial.openTurn("live",new AbortController().signal);
let delayed;
await runWithStreamingContext({messageId:"live",modelAttemptTurnId:"live",modelAttemptLease:activeLease},async()=> { delayed=guardFor(); });
activeLease.close(); assert.throws(()=>delayed.assertBeforeAttempt(),/ended/);
end.abort(); assert.throws(()=>activeTrial.openTurn("later",new AbortController().signal),/ended/);
`,
	],
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
