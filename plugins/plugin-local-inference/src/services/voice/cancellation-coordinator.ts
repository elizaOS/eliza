/**
 * Voice cancellation coordinator — Wave 3 W3-9.
 *
 * Single brain that owns one `VoiceCancellationToken` per active voice turn
 * and binds every cancellation source into it:
 *
 *   1. VAD start-of-speech while the agent is speaking (barge-in).
 *   2. `BargeInController.hardStop` (ASR-confirmed barge-in words).
 *   3. Turn-detector EOT revocation (user resumed mid-tentative-pause).
 *   4. Runtime turn abort (`TurnControllerRegistry` "aborted" event).
 *
 * On any cancel, it fans out to:
 *
 *   1. The voice token's `AbortSignal` — every fetch / model call wired to
 *      `signal` aborts at the next yield point.
 *   2. `runtime.turnControllers.abortTurn(roomId, reason)` — the runtime's
 *      planner-loop / action handlers see the abort within one tick
 *      (between model calls / between actions / between provider calls).
 *   3. Optional `slotAbort(slotId)` — invokes the registered LM
 *      slot-abort callback (typically `DflashLlamaServer.abortSlot` which
 *      either aborts in-flight HTTP fetches against that slot or, on a
 *      capable fork, calls the slot-cancel REST route).
 *   4. Optional `ttsStop()` — invokes the registered TTS-stop callback
 *      (typically `EngineVoiceBridge.triggerBargeIn` which drains the
 *      audio sink + cancels the FFI/HTTP synthesis path).
 *
 * The coordinator is intentionally a plain class — no engine coupling. The
 * engine bridge (and tests) construct one with the structural runtime + the
 * appropriate callbacks.
 */

import {
	type VoiceCancellationReason,
	VoiceCancellationRegistry,
	type VoiceCancellationToken,
} from "@elizaos/shared";

/**
 * Minimum runtime surface this coordinator needs. Matches a subset of
 * `AgentRuntime.turnControllers`. Structural so unit tests can pass a fake.
 */
export interface CoordinatorRuntime {
	turnControllers: {
		abortTurn(roomId: string, reason: string): boolean;
		onEvent(
			listener: (event: {
				type:
					| "started"
					| "completed"
					| "errored"
					| "aborted"
					| "aborted-cleanup";
				roomId: string;
				reason?: string;
			}) => void,
		): () => void;
	};
}

export interface VoiceCancellationCoordinatorOptions {
	/** The runtime to bind to. */
	runtime: CoordinatorRuntime;
	/**
	 * Abort the inference server slot. Wired to `DflashLlamaServer.abortSlot`
	 * in production. Async — the coordinator does NOT await it (the slot
	 * abort path is best-effort; the AbortSignal closure on the fetch is the
	 * authoritative cancel).
	 */
	slotAbort?: (slotId: number, reason: VoiceCancellationReason) => void;
	/**
	 * Hard-stop the TTS pipeline (audio sink drain + FFI/HTTP synthesis
	 * cancel). Wired to `EngineVoiceBridge.triggerBargeIn`. Synchronous —
	 * the audio sink drain MUST happen within one tick of `abort()`.
	 */
	ttsStop?: (reason: VoiceCancellationReason) => void;
	/**
	 * Optional pre-existing registry. Tests inject one to inspect token
	 * lifecycle directly. Production creates a fresh registry per session.
	 */
	registry?: VoiceCancellationRegistry;
}

/**
 * Per-turn metadata. Recorded when `armTurn` is called so that the
 * coordinator can map a generic `runtime.turnControllers` "aborted" event
 * for a room back to the voice token (and so the slot-abort path knows
 * which slot to target).
 */
interface ArmedTurn {
	roomId: string;
	runId: string;
	slot?: number;
	token: VoiceCancellationToken;
	unsubRuntime: () => void;
}

export class VoiceCancellationCoordinator {
	private readonly runtime: CoordinatorRuntime;
	private readonly slotAbort: VoiceCancellationCoordinatorOptions["slotAbort"];
	private readonly ttsStop: VoiceCancellationCoordinatorOptions["ttsStop"];
	private readonly registry: VoiceCancellationRegistry;
	/** Active turns keyed by roomId. One per room. */
	private readonly armed = new Map<string, ArmedTurn>();

	constructor(opts: VoiceCancellationCoordinatorOptions) {
		this.runtime = opts.runtime;
		this.slotAbort = opts.slotAbort;
		this.ttsStop = opts.ttsStop;
		this.registry = opts.registry ?? new VoiceCancellationRegistry();
	}

	/**
	 * Begin a new voice turn for `roomId`. If a previous turn was active,
	 * it is aborted with `"external"` (the regular replace-on-arm semantics
	 * inherited from `VoiceCancellationRegistry`).
	 */
	armTurn(args: {
		roomId: string;
		runId: string;
		slot?: number;
	}): VoiceCancellationToken {
		// Tear down any previous arming for the same room before reusing it.
		const prior = this.armed.get(args.roomId);
		if (prior) {
			prior.unsubRuntime();
			this.armed.delete(args.roomId);
		}

		const token = this.registry.arm(args.roomId, {
			runId: args.runId,
			...(args.slot !== undefined ? { slot: args.slot } : {}),
		});

		// Fan out: when the token aborts, abort the runtime turn + slot + TTS.
		token.onAbort((reason) => {
			// Runtime turn abort — fires the planner-loop / action-handler
			// abort signal merged into StreamingContext.
			try {
				this.runtime.turnControllers.abortTurn(args.roomId, reason);
			} catch {
				// Telemetry shouldn't fail cancellation.
			}
			if (args.slot !== undefined && this.slotAbort) {
				try {
					this.slotAbort(args.slot, reason);
				} catch {
					// Slot abort is best-effort.
				}
			}
			if (this.ttsStop) {
				try {
					this.ttsStop(reason);
				} catch {
					// TTS hard-stop is best-effort; the audio sink owns the SIGKILL.
				}
			}
		});

		// Reverse direction: when the runtime aborts the turn (e.g. APP_PAUSE,
		// orchestrator-initiated cancel), trip the voice token. This is the
		// "runtime → voice" leg the R11 audit called out as missing.
		const unsubRuntime = this.runtime.turnControllers.onEvent((event) => {
			if (event.roomId !== args.roomId) return;
			if (event.type === "aborted" || event.type === "aborted-cleanup") {
				const reason = mapRuntimeReason(event.reason);
				if (!token.aborted) {
					token.abort(reason);
				}
			}
		});

		this.armed.set(args.roomId, {
			roomId: args.roomId,
			runId: args.runId,
			...(args.slot !== undefined ? { slot: args.slot } : {}),
			token,
			unsubRuntime,
		});

		return token;
	}

	/** Fetch the current voice token for `roomId`, or null. */
	current(roomId: string): VoiceCancellationToken | null {
		return this.registry.current(roomId);
	}

	/** Snapshot of armed room ids. */
	armedRoomIds(): string[] {
		return Array.from(this.armed.keys());
	}

	/**
	 * Abort the active turn for `roomId` with the given reason. Idempotent.
	 * Returns true when a live token was aborted.
	 */
	abort(roomId: string, reason: VoiceCancellationReason): boolean {
		return this.registry.abort(roomId, reason);
	}

	/**
	 * Trip the active token because VAD reported start-of-speech while the
	 * agent was speaking. Equivalent to `abort(roomId, "barge-in")` but
	 * keeps the call-site grep-able as the canonical barge-in entry point.
	 */
	bargeIn(roomId: string): boolean {
		return this.abort(roomId, "barge-in");
	}

	/**
	 * Trip the active token because the turn detector revoked the previous
	 * EOT decision (user resumed within the rollback window).
	 */
	revokeEot(roomId: string): boolean {
		return this.abort(roomId, "eot-revoked");
	}

	/**
	 * Wire a `BargeInController.onSignal` listener into this coordinator.
	 * The controller emits `hard-stop` when ASR confirms barge-in words;
	 * this glue translates it into `coordinator.bargeIn(roomId)` so the
	 * canonical token (and every downstream consumer) sees the abort.
	 *
	 * Returns the unsubscribe function from `onSignal`. Production callers
	 * (the engine bridge) call this once per `BargeInController` per
	 * room and keep the handle until session teardown.
	 */
	bindBargeInController(
		roomId: string,
		controller: {
			onSignal(
				listener: (signal: { type: string }) => void,
			): () => void;
		},
	): () => void {
		return controller.onSignal((signal) => {
			if (signal.type === "hard-stop") {
				this.bargeIn(roomId);
			}
		});
	}

	/**
	 * Tear down. Cancels every armed turn and unsubscribes from the
	 * runtime. Safe to call multiple times.
	 */
	dispose(): void {
		for (const arm of Array.from(this.armed.values())) {
			arm.unsubRuntime();
			if (!arm.token.aborted) {
				arm.token.abort("external");
			}
		}
		this.armed.clear();
	}
}

/**
 * Map a freeform runtime-abort reason string into a `VoiceCancellationReason`.
 * Conservative: anything that looks like a known voice reason stays as-is,
 * everything else is `"external"` (the runtime decided independently of the
 * voice loop).
 */
function mapRuntimeReason(reason: string | undefined): VoiceCancellationReason {
	if (!reason) return "external";
	if (reason === "barge-in" || reason === "voice-barge-in") return "barge-in";
	if (reason === "eot-revoked") return "eot-revoked";
	if (reason === "user-cancel") return "user-cancel";
	if (reason === "timeout") return "timeout";
	return "external";
}
