/**
 * Production-path tests for the W3-9 / F1 cancellation wiring on
 * `EngineVoiceBridge`. Pinned by the F1 brief:
 *
 *   1. The coordinator is instantiated on `start()` when a `runtime` option
 *      is supplied (and absent when it is not).
 *   2. VAD speech-start during an active turn fires
 *      `coordinator.abort('barge-in')` — exercised here through the
 *      bridge's `triggerBargeIn()` surface (the VAD source's
 *      speech-start callback is the canonical caller in the live loop)
 *      and through `coordinator.bargeIn(roomId)` directly.
 *   3. EOT prefill respects `OptimisticGenerationPolicy.shouldStartOptimisticLm`
 *      — verified by driving a `VoiceStateMachine` constructed with the
 *      bridge's policy through a tentative-EOT partial transcript on
 *      battery and on plugged-in mode.
 *   4. `bindBargeInController` is called when a controller is provided —
 *      verified by calling `bindBargeInControllerForRoom(roomId)` and
 *      firing the scheduler's `BargeInController.hardStop` to assert
 *      the canonical token aborts with reason="barge-in".
 *
 * The bridge here runs against the stub TTS backend + injected lifecycle
 * loaders so the tests don't depend on a fused libelizainference build.
 * The W3-9 contract is unchanged on this path: the coordinator owns the
 * token, the bridge owns the coordinator, the state machine reads the
 * policy at firePrefill.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	CoordinatorRuntime,
	VoiceCancellationCoordinator,
} from "./cancellation-coordinator";
import type { CheckpointHandle } from "./checkpoint-manager";
import { EngineVoiceBridge } from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import { OptimisticGenerationPolicy } from "./optimistic-policy";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import { writeVoicePresetFile } from "./voice-preset-format";
import { VoiceStateMachine } from "./voice-state-machine";

type RuntimeEvent = Parameters<
	Parameters<CoordinatorRuntime["turnControllers"]["onEvent"]>[0]
>[0];

function writePresetBundle(root: string): void {
	mkdirSync(path.join(root, "cache"), { recursive: true });
	const embedding = new Float32Array(16);
	for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
	writeFileSync(
		path.join(root, "cache", "voice-preset-default.bin"),
		Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
	);
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
	const region: MmapRegionHandle = {
		id: "region-ok",
		path: "/tmp/tts-ok",
		sizeBytes: 1024,
		async evictPages() {},
		async release() {},
	};
	const refc: RefCountedResource = { id: "refc-ok", async release() {} };
	return {
		loadTtsRegion: async () => region,
		loadAsrRegion: async () => region,
		loadVoiceCaches: async () => refc,
		loadVoiceSchedulerNodes: async () => refc,
	};
}

function makeFakeRuntime(): CoordinatorRuntime & {
	emitEvent(event: RuntimeEvent): void;
	abortCalls: Array<{ roomId: string; reason: string }>;
} {
	const listeners = new Set<(e: RuntimeEvent) => void>();
	const abortCalls: Array<{ roomId: string; reason: string }> = [];
	return {
		turnControllers: {
			abortTurn(roomId, reason) {
				abortCalls.push({ roomId, reason });
				return true;
			},
			onEvent(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		emitEvent(event) {
			for (const l of listeners) l(event);
		},
		abortCalls,
	};
}

/** No-op `CheckpointManagerLike` for the state-machine test. */
function noopCheckpointManager(): import("./checkpoint-manager").CheckpointManagerLike {
	let counter = 0;
	const next = (slotId: string, name: string): CheckpointHandle => ({
		slotId,
		name,
		id: counter++,
		createdAt: new Date(0).toISOString(),
		backendRef: null,
	});
	return {
		async saveCheckpoint(slotId, name) {
			return next(slotId, name);
		},
		async restoreCheckpoint() {},
		async discardCheckpoint() {},
	};
}

/** EOT classifier stub — always returns the prepared probability. */
function fixedEotClassifier(prob: number) {
	return {
		async score(_partial: string): Promise<number> {
			return prob;
		},
	};
}

/**
 * Assert helper that narrows the bridge's nullable coordinator surface for
 * test code paths where the test setup guarantees a runtime was supplied.
 */
function requireCoordinator(
	bridge: EngineVoiceBridge,
): VoiceCancellationCoordinator {
	const c = bridge.cancellationCoordinatorOrNull();
	if (c === null) {
		throw new Error(
			"Test precondition: bridge was constructed without a runtime",
		);
	}
	return c;
}

describe("EngineVoiceBridge — W3-9 cancellation wiring (production path)", () => {
	let bundleRoot: string;

	beforeEach(() => {
		bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-f1-cancel-"));
		writePresetBundle(bundleRoot);
	});

	afterEach(() => {
		rmSync(bundleRoot, { recursive: true, force: true });
	});

	it("instantiates a VoiceCancellationCoordinator + OptimisticGenerationPolicy when runtime is supplied", () => {
		const rt = makeFakeRuntime();
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			runtime: rt,
		});

		const coordinator = bridge.cancellationCoordinatorOrNull();
		const policy = bridge.optimisticPolicyOrNull();
		expect(coordinator).not.toBeNull();
		expect(policy).not.toBeNull();
		// Default policy is enabled in tests (no battery telemetry → unknown
		// → treated as plugged-in by the resolver).
		expect(policy?.enabled()).toBe(true);
	});

	it("exposes null coordinator + policy when runtime is not supplied (back-compat)", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		expect(bridge.cancellationCoordinatorOrNull()).toBeNull();
		expect(bridge.optimisticPolicyOrNull()).toBeNull();
	});

	it("VAD speech-start during an active turn fires coordinator.abort('barge-in') via bargeIn(roomId)", () => {
		const rt = makeFakeRuntime();
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			runtime: rt,
		});
		const coordinator = requireCoordinator(bridge);

		// Arm a turn (the canonical caller: turn-controller / state-machine).
		const token = coordinator.armTurn({ roomId: "room-A", runId: "t-1" });
		expect(token.aborted).toBe(false);

		// Simulate VAD speech-start during agent-speaking — the wired call.
		const aborted = coordinator.bargeIn("room-A");
		expect(aborted).toBe(true);
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("barge-in");
		// Runtime turn was aborted in lock-step.
		expect(rt.abortCalls).toEqual([{ roomId: "room-A", reason: "barge-in" }]);
	});

	it("triggerBargeIn() wired as ttsStop callback fires when the coordinator aborts", () => {
		const rt = makeFakeRuntime();
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			runtime: rt,
		});
		const coordinator = requireCoordinator(bridge);
		const spy = vi.spyOn(bridge, "triggerBargeIn");
		coordinator.armTurn({ roomId: "room-B", runId: "t-1", slot: 5 });
		coordinator.bargeIn("room-B");
		expect(spy).toHaveBeenCalled();
	});

	it("bindBargeInControllerForRoom wires the scheduler's controller into the coordinator", () => {
		const rt = makeFakeRuntime();
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			runtime: rt,
		});
		const coordinator = requireCoordinator(bridge);
		const token = coordinator.armTurn({
			roomId: "room-C",
			runId: "t-1",
			slot: 7,
		});

		const unsub = bridge.bindBargeInControllerForRoom("room-C");

		// Simulate the bridge's `BargeInController` firing hard-stop (the
		// ASR-confirmed barge-in words path).
		bridge.scheduler.bargeIn.setAgentSpeaking(true);
		bridge.scheduler.bargeIn.hardStop("barge-in-words");

		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("barge-in");
		expect(rt.abortCalls).toEqual([{ roomId: "room-C", reason: "barge-in" }]);

		unsub();
		// After unsub, a fresh turn must not be aborted by another hard-stop.
		bridge.scheduler.bargeIn.reset();
		const fresh = coordinator.armTurn({ roomId: "room-C", runId: "t-2" });
		bridge.scheduler.bargeIn.setAgentSpeaking(true);
		bridge.scheduler.bargeIn.hardStop("manual");
		expect(fresh.aborted).toBe(false);
	});

	it("bindBargeInControllerForRoom is a no-op when runtime is not supplied", () => {
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
		});
		const unsub = bridge.bindBargeInControllerForRoom("room-X");
		// Calling the returned unsub does not throw.
		expect(() => unsub()).not.toThrow();
	});

	it("dispose tears down barge-in bindings and the coordinator", () => {
		const rt = makeFakeRuntime();
		const bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			runtime: rt,
		});
		const coordinator = requireCoordinator(bridge);
		const token = coordinator.armTurn({ roomId: "room-D", runId: "t-1" });
		bridge.bindBargeInControllerForRoom("room-D");
		bridge.dispose();
		expect(token.aborted).toBe(true);
		expect(token.reason).toBe("external");
	});
});

describe("VoiceStateMachine — firePrefill gated by OptimisticGenerationPolicy", () => {
	it("policy.shouldStartOptimisticLm(eotProb) suppresses the prefill on battery", async () => {
		const policy = new OptimisticGenerationPolicy();
		policy.setPowerSource("battery");
		expect(policy.enabled()).toBe(false);

		const mgr = noopCheckpointManager();
		const startDrafter = vi.fn(() => ({
			abort() {},
		}));
		// Mock global fetch so a leaked prefill is observable.
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		const machine = new VoiceStateMachine({
			slotId: "slot-A",
			checkpointManager: mgr,
			startDrafter,
			optimisticPolicy: policy,
			eotClassifier: fixedEotClassifier(0.7),
			prefillConfig: { baseUrl: "http://localhost:9999" },
		});

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "hi there",
			silenceSinceMs: 100,
		});
		// Allow microtasks to settle.
		await Promise.resolve();

		// The state machine should have entered PAUSE_TENTATIVE and kicked the
		// drafter, but the prefill must be suppressed by the policy.
		expect(startDrafter).toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("policy on plugged-in lets firePrefill through (default behaviour)", async () => {
		const policy = new OptimisticGenerationPolicy();
		policy.setPowerSource("plugged-in");
		expect(policy.enabled()).toBe(true);

		const mgr = noopCheckpointManager();
		const startDrafter = vi.fn(() => ({
			abort() {},
		}));
		// Resolve with a checkpoint shape the C7 path consumes.
		const prefillBody = JSON.stringify({
			tokens_predicted: 1,
			truncated: false,
			content: "",
			__voice_eliza_checkpoint__: {
				slotId: "slot-A",
				filename: "prefill",
				tokenCount: 1,
			},
		});
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(prefillBody, { status: 200 }));

		const machine = new VoiceStateMachine({
			slotId: "slot-A",
			checkpointManager: mgr,
			startDrafter,
			optimisticPolicy: policy,
			eotClassifier: fixedEotClassifier(0.7),
			prefillConfig: { baseUrl: "http://localhost:9999" },
		});

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "hi there",
			silenceSinceMs: 100,
		});
		// Settle microtasks for the fire-and-forget prefill.
		await Promise.resolve();
		await Promise.resolve();

		expect(startDrafter).toHaveBeenCalled();
		// Prefill fetch fired because the policy allowed it.
		expect(fetchSpy).toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("policy below the EOT threshold suppresses the prefill even on plugged-in", async () => {
		const policy = new OptimisticGenerationPolicy({ eotThreshold: 0.95 });
		policy.setPowerSource("plugged-in");
		expect(policy.enabled()).toBe(true);
		// EOT prob below the policy's threshold:
		expect(policy.shouldStartOptimisticLm(0.7)).toBe(false);

		const mgr = noopCheckpointManager();
		const startDrafter = vi.fn(() => ({
			abort() {},
		}));
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));

		const machine = new VoiceStateMachine({
			slotId: "slot-A",
			checkpointManager: mgr,
			startDrafter,
			optimisticPolicy: policy,
			eotClassifier: fixedEotClassifier(0.7),
			prefillConfig: { baseUrl: "http://localhost:9999" },
		});

		await machine.dispatch({ type: "speech-start", timestampMs: 0 });
		await machine.dispatch({
			type: "partial-transcript",
			timestampMs: 200,
			text: "hi there",
			silenceSinceMs: 100,
		});
		await Promise.resolve();

		// Drafter still kicks (it's gated on EOT_TENTATIVE_THRESHOLD, not policy),
		// but the prefill fetch must not have been made.
		expect(startDrafter).toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
