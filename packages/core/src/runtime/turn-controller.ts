/**
 * Turn-scoped AbortController registry.
 *
 * Every inbound message handler invocation runs inside a turn controller.
 * The controller's signal threads through:
 *
 *   - The Stage-1 response-handler LLM call
 *   - Response-handler field evaluators
 *   - The planner loop and per-step LLM calls
 *   - Action handlers
 *   - Sub-process / fetch / sub-agent spawns
 *
 * When the user (or a sibling field-evaluator like threadOps' abort op) wants
 * to abort the turn, they call `registry.abortTurn(roomId, reason)`. This
 * fires the controller, which propagates through every consumer that respects
 * the signal.
 *
 * Synchronous vs background:
 *
 *   - Sync sub-tasks share the parent's signal directly.
 *   - Background sub-agents (Claude Code / Codex / Pi spawned via plugin-
 *     agent-orchestrator) get their own AbortController but register a
 *     parent-signal listener that aborts the child when the parent fires.
 *     This is set up at spawn time by the orchestrator, NOT here.
 *
 * Crash safety:
 *
 *   - Controllers live in memory. A process crash loses them — that's fine
 *     because there's no in-flight turn anymore.
 *   - The registry never holds stale controllers. `runWith` always unregisters
 *     on exit (success, error, or abort).
 */

export class TurnAbortedError extends Error {
	readonly code = "TURN_ABORTED";
	readonly reason: string;
	constructor(reason: string) {
		super(`Turn aborted: ${reason}`);
		this.reason = reason;
	}
}

export class DuplicateTurnRequestAdmissionError extends Error {
	readonly code = "DUPLICATE_TURN_REQUEST_ADMISSION";
	readonly roomId: string;
	readonly clientMessageId: string;

	constructor(roomId: string, clientMessageId: string) {
		super(
			`Turn request already admitted: room=${roomId} clientMessageId=${clientMessageId}`,
		);
		this.roomId = roomId;
		this.clientMessageId = clientMessageId;
	}
}

export type TurnRequestIngressState = "pending" | "committed" | "failed";

export type TurnRequestIngressFailure =
	| "request_finished_before_ingress"
	| "abort_tombstone_expired"
	| "abort_tombstone_capacity";

export interface TurnRequestAdmission {
	readonly roomId: string;
	readonly clientMessageId: string;
	readonly signal: AbortSignal;
	readonly settlement: Promise<void>;
	readonly requestIngressState: TurnRequestIngressState;
	readonly requestIngressFailure: TurnRequestIngressFailure | null;
	/** Idempotently record that the exact user ingress is durable. */
	markIngressCommitted(): boolean;
	/** Idempotently fail ingress before the request capability is released. */
	markIngressFailed(reason: TurnRequestIngressFailure): boolean;
	/** Idempotently release this exact request capability. */
	finish(): void;
}

export interface TurnRequestAbortResult {
	/** This call newly aborted the exact already-registered request. */
	readonly requestAborted: boolean;
	/** The exact request was already registered when abort was requested. */
	readonly requestObserved: boolean;
	/** A bounded pre-registration cancellation tombstone owns this key. */
	readonly requestArmed: boolean;
	/** Capacity refusal means no cancellation tombstone was installed. */
	readonly requestArmRejected: boolean;
	readonly requestIngressState: TurnRequestIngressState;
	readonly requestIngressFailure: TurnRequestIngressFailure | null;
	/** Resolves only after exact ingress and all request work settle. */
	readonly settlement: Promise<void>;
}

export interface TurnControllerRegistryOptions {
	/** Injectable only for bounded tombstone expiry tests. */
	requestAdmissionNow?: () => number;
	requestAbortTombstoneTtlMs?: number;
	requestAbortTombstoneCapacity?: number;
}

interface ActiveRequestAdmission {
	roomId: string;
	clientMessageId: string;
	controller: AbortController;
	lifecycle: RequestAdmissionLifecycle;
}

interface RequestAbortTombstone {
	reason: string;
	expiresAt: number;
	lifecycle: RequestAdmissionLifecycle;
}

interface RequestAdmissionLifecycle {
	ingressState: TurnRequestIngressState;
	ingressFailure: TurnRequestIngressFailure | null;
	settled: Promise<void>;
	markSettled: () => void;
	settledDone: boolean;
}

interface RequestTerminalReceipt {
	requestObserved: boolean;
	ingressState: Exclude<TurnRequestIngressState, "pending">;
	ingressFailure: TurnRequestIngressFailure | null;
	expiresAt: number;
}

const DEFAULT_REQUEST_ABORT_TOMBSTONE_TTL_MS = 30_000;
const DEFAULT_REQUEST_ABORT_TOMBSTONE_CAPACITY = 1_024;

function boundedPositiveInteger(value: number | undefined, fallback: number) {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	const integer = Math.floor(value);
	return integer > 0 ? integer : fallback;
}

function requestAdmissionKey(roomId: string, clientMessageId: string): string {
	return JSON.stringify([roomId, clientMessageId]);
}

interface ActiveTurn {
	roomId: string;
	controller: AbortController;
	startedAt: number;
	settled: Promise<void>;
	markSettled: () => void;
	reason?: string;
}

export class TurnControllerRegistry {
	private active = new Map<string, ActiveTurn>();
	private activeRequestAdmissions = new Map<string, ActiveRequestAdmission>();
	private requestAbortTombstones = new Map<string, RequestAbortTombstone>();
	private requestTerminalReceipts = new Map<string, RequestTerminalReceipt>();
	private listeners = new Set<(event: TurnEvent) => void>();
	private readonly requestAdmissionNow: () => number;
	private readonly requestAbortTombstoneTtlMs: number;
	private readonly requestAbortTombstoneCapacity: number;

	constructor(options: TurnControllerRegistryOptions = {}) {
		this.requestAdmissionNow = options.requestAdmissionNow ?? Date.now;
		this.requestAbortTombstoneTtlMs = boundedPositiveInteger(
			options.requestAbortTombstoneTtlMs,
			DEFAULT_REQUEST_ABORT_TOMBSTONE_TTL_MS,
		);
		this.requestAbortTombstoneCapacity = boundedPositiveInteger(
			options.requestAbortTombstoneCapacity,
			DEFAULT_REQUEST_ABORT_TOMBSTONE_CAPACITY,
		);
	}

	/**
	 * Register an exact inbound request before it enters asynchronous admission.
	 * A matching pre-abort tombstone is consumed and the returned signal starts
	 * aborted, closing the cancel-before-registration race.
	 */
	registerRequestAdmission(
		roomId: string,
		clientMessageId: string,
	): TurnRequestAdmission {
		if (!roomId || !clientMessageId) {
			throw new TypeError("roomId and clientMessageId are required");
		}
		this.purgeExpiredRequestAbortTombstones();
		const key = requestAdmissionKey(roomId, clientMessageId);
		if (
			this.activeRequestAdmissions.has(key) ||
			this.requestTerminalReceipts.has(key)
		) {
			throw new DuplicateTurnRequestAdmissionError(roomId, clientMessageId);
		}

		const controller = new AbortController();
		const tombstone = this.requestAbortTombstones.get(key);
		const lifecycle = tombstone?.lifecycle ?? this.createRequestLifecycle();
		const admission: ActiveRequestAdmission = {
			roomId,
			clientMessageId,
			controller,
			lifecycle,
		};
		this.activeRequestAdmissions.set(key, admission);

		if (tombstone) {
			this.requestAbortTombstones.delete(key);
			controller.abort(new TurnAbortedError(tombstone.reason));
		}

		let finished = false;
		return {
			roomId,
			clientMessageId,
			signal: controller.signal,
			settlement: lifecycle.settled,
			get requestIngressState() {
				return lifecycle.ingressState;
			},
			get requestIngressFailure() {
				return lifecycle.ingressFailure;
			},
			markIngressCommitted: () =>
				this.setRequestIngress(lifecycle, "committed", null),
			markIngressFailed: (reason) =>
				this.setRequestIngress(lifecycle, "failed", reason),
			finish: () => {
				if (finished) return;
				finished = true;
				if (lifecycle.ingressState === "pending") {
					this.setRequestIngress(
						lifecycle,
						"failed",
						"request_finished_before_ingress",
					);
				}
				if (this.activeRequestAdmissions.get(key) === admission) {
					this.activeRequestAdmissions.delete(key);
				}
				this.storeTerminalReceipt(key, true, lifecycle);
				this.settleRequestLifecycle(lifecycle);
			},
		};
	}

	/** Abort one exact request, or arm a bounded tombstone before registration. */
	abortRequestAdmission(
		roomId: string,
		clientMessageId: string,
		reason: string,
	): TurnRequestAbortResult {
		if (!roomId || !clientMessageId) {
			throw new TypeError("roomId and clientMessageId are required");
		}
		this.purgeExpiredRequestAbortTombstones();
		const key = requestAdmissionKey(roomId, clientMessageId);
		const admission = this.activeRequestAdmissions.get(key);
		if (admission) {
			const aborted = !admission.controller.signal.aborted;
			if (aborted) {
				admission.controller.abort(new TurnAbortedError(reason));
			}
			return this.requestAbortResult({
				requestAborted: aborted,
				requestObserved: true,
				requestArmed: false,
				requestArmRejected: false,
				lifecycle: admission.lifecycle,
			});
		}

		const receipt = this.requestTerminalReceipts.get(key);
		if (receipt) {
			const lifecycle = this.createRequestLifecycle();
			lifecycle.ingressState = receipt.ingressState;
			lifecycle.ingressFailure = receipt.ingressFailure;
			this.settleRequestLifecycle(lifecycle);
			return this.requestAbortResult({
				requestAborted: false,
				requestObserved: receipt.requestObserved,
				requestArmed: false,
				requestArmRejected: false,
				lifecycle,
			});
		}

		const existingTombstone = this.requestAbortTombstones.get(key);
		if (existingTombstone) {
			return this.requestAbortResult({
				requestAborted: false,
				requestObserved: false,
				requestArmed: true,
				requestArmRejected: false,
				lifecycle: existingTombstone.lifecycle,
			});
		}

		if (
			this.requestAbortTombstones.size >= this.requestAbortTombstoneCapacity
		) {
			const lifecycle = this.createRequestLifecycle();
			this.setRequestIngress(lifecycle, "failed", "abort_tombstone_capacity");
			this.settleRequestLifecycle(lifecycle);
			return this.requestAbortResult({
				requestAborted: false,
				requestObserved: false,
				requestArmed: false,
				requestArmRejected: true,
				lifecycle,
			});
		}
		const lifecycle = this.createRequestLifecycle();
		this.requestAbortTombstones.set(key, {
			reason,
			expiresAt: this.requestAdmissionNow() + this.requestAbortTombstoneTtlMs,
			lifecycle,
		});
		return this.requestAbortResult({
			requestAborted: false,
			requestObserved: false,
			requestArmed: true,
			requestArmRejected: false,
			lifecycle,
		});
	}

	hasRequestAdmission(roomId: string, clientMessageId: string): boolean {
		return this.activeRequestAdmissions.has(
			requestAdmissionKey(roomId, clientMessageId),
		);
	}

	private purgeExpiredRequestAbortTombstones(): void {
		const now = this.requestAdmissionNow();
		for (const [key, tombstone] of this.requestAbortTombstones) {
			if (tombstone.expiresAt <= now) {
				this.requestAbortTombstones.delete(key);
				this.setRequestIngress(
					tombstone.lifecycle,
					"failed",
					"abort_tombstone_expired",
				);
				this.storeTerminalReceipt(key, false, tombstone.lifecycle);
				this.settleRequestLifecycle(tombstone.lifecycle);
			}
		}
		for (const [key, receipt] of this.requestTerminalReceipts) {
			if (receipt.expiresAt <= now) this.requestTerminalReceipts.delete(key);
		}
	}

	private createRequestLifecycle(): RequestAdmissionLifecycle {
		let markSettled: (() => void) | undefined;
		const settled = new Promise<void>((resolve) => {
			markSettled = resolve;
		});
		return {
			ingressState: "pending",
			ingressFailure: null,
			settled,
			markSettled: () => markSettled?.(),
			settledDone: false,
		};
	}

	private setRequestIngress(
		lifecycle: RequestAdmissionLifecycle,
		state: Exclude<TurnRequestIngressState, "pending">,
		failure: TurnRequestIngressFailure | null,
	): boolean {
		if (lifecycle.ingressState !== "pending") return false;
		lifecycle.ingressState = state;
		lifecycle.ingressFailure = failure;
		return true;
	}

	private settleRequestLifecycle(lifecycle: RequestAdmissionLifecycle): void {
		if (lifecycle.settledDone) return;
		lifecycle.settledDone = true;
		lifecycle.markSettled();
	}

	private storeTerminalReceipt(
		key: string,
		requestObserved: boolean,
		lifecycle: RequestAdmissionLifecycle,
	): void {
		if (lifecycle.ingressState === "pending") return;
		while (
			this.requestTerminalReceipts.size >= this.requestAbortTombstoneCapacity
		) {
			const oldestKey = this.requestTerminalReceipts.keys().next().value;
			if (typeof oldestKey !== "string") break;
			this.requestTerminalReceipts.delete(oldestKey);
		}
		this.requestTerminalReceipts.set(key, {
			requestObserved,
			ingressState: lifecycle.ingressState,
			ingressFailure: lifecycle.ingressFailure,
			expiresAt: this.requestAdmissionNow() + this.requestAbortTombstoneTtlMs,
		});
	}

	private requestAbortResult(input: {
		requestAborted: boolean;
		requestObserved: boolean;
		requestArmed: boolean;
		requestArmRejected: boolean;
		lifecycle: RequestAdmissionLifecycle;
	}): TurnRequestAbortResult {
		return {
			requestAborted: input.requestAborted,
			requestObserved: input.requestObserved,
			requestArmed: input.requestArmed,
			requestArmRejected: input.requestArmRejected,
			get requestIngressState() {
				return input.lifecycle.ingressState;
			},
			get requestIngressFailure() {
				return input.lifecycle.ingressFailure;
			},
			settlement: input.lifecycle.settled,
		};
	}

	/**
	 * Run `fn` inside a turn-scoped AbortController. The signal is passed to
	 * `fn` and registered under `roomId` for the duration. When `fn` exits
	 * (normally, throwing, or aborted), the controller is removed from the
	 * registry.
	 *
	 * Concurrent turns for the SAME `roomId` are allowed by this registry — it
	 * just records the latest. Use `RoomHandlerQueue` to enforce one-at-a-time
	 * per room.
	 */
	async runWith<T>(
		roomId: string,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		let markSettled: (() => void) | undefined;
		const settled = new Promise<void>((resolve) => {
			markSettled = resolve;
		});
		const turn: ActiveTurn = {
			roomId,
			controller,
			startedAt: Date.now(),
			settled,
			markSettled: () => markSettled?.(),
		};
		this.active.set(roomId, turn);
		this.emit({ type: "started", roomId, startedAt: turn.startedAt });
		try {
			const result = await fn(controller.signal);
			this.emit({
				type: "completed",
				roomId,
				durationMs: Date.now() - turn.startedAt,
			});
			return result;
		} catch (error) {
			// error-policy:J1 The per-room turn boundary emits its terminal
			// failure state and preserves the operation error.
			if (controller.signal.aborted) {
				this.emit({
					type: "aborted-cleanup",
					roomId,
					reason: turn.reason ?? "unknown",
					durationMs: Date.now() - turn.startedAt,
				});
			} else {
				this.emit({
					type: "errored",
					roomId,
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - turn.startedAt,
				});
			}
			throw error;
		} finally {
			if (this.active.get(roomId) === turn) {
				this.active.delete(roomId);
			}
			turn.markSettled();
		}
	}

	/**
	 * Abort the active turn for `roomId`. No-op if there's no active turn.
	 * Returns true if a turn was aborted.
	 */
	abortTurn(roomId: string, reason: string): boolean {
		const turn = this.active.get(roomId);
		if (!turn) return false;
		if (turn.controller.signal.aborted) return false;
		turn.reason = reason;
		turn.controller.abort(new TurnAbortedError(reason));
		this.emit({ type: "aborted", roomId, reason });
		return true;
	}

	/**
	 * Abort every active turn. Used by lifecycle handlers (APP_PAUSE on
	 * mobile, container shutdown) that need to release all in-flight
	 * inference at once. Returns the room ids that were actually aborted —
	 * already-aborted turns are skipped.
	 */
	abortAllTurns(reason: string): string[] {
		const aborted: string[] = [];
		for (const roomId of Array.from(this.active.keys())) {
			if (this.abortTurn(roomId, reason)) {
				aborted.push(roomId);
			}
		}
		return aborted;
	}

	hasActiveTurn(roomId: string): boolean {
		return this.active.has(roomId);
	}

	/**
	 * Snapshot of the currently-active turn room ids. Useful for diagnostic
	 * endpoints that want to surface "what's running" without holding a
	 * reference to the registry's internal map.
	 */
	activeRoomIds(): string[] {
		return Array.from(this.active.keys());
	}

	/**
	 * Returns the AbortSignal for the active turn on `roomId`, or null. Used
	 * by long-running tools that want to check abort status mid-execution.
	 */
	signalFor(roomId: string): AbortSignal | null {
		return this.active.get(roomId)?.controller.signal ?? null;
	}

	/** Snapshot cleanup of the turn active at this instant, if any. */
	settlementFor(roomId: string): Promise<void> | null {
		return this.active.get(roomId)?.settled ?? null;
	}

	/**
	 * Subscribe to turn lifecycle events. Useful for telemetry and the
	 * InterruptBench harness.
	 */
	onEvent(listener: (event: TurnEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(event: TurnEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// error-policy:J7 Turn-controller listeners are telemetry observers.
				// Listener errors are swallowed; telemetry should not affect runtime.
			}
		}
	}
}

export type TurnEvent =
	| { type: "started"; roomId: string; startedAt: number }
	| { type: "completed"; roomId: string; durationMs: number }
	| { type: "errored"; roomId: string; error: string; durationMs: number }
	| { type: "aborted"; roomId: string; reason: string }
	| {
			type: "aborted-cleanup";
			roomId: string;
			reason: string;
			durationMs: number;
	  };

/**
 * Minimum runtime surface needed to abort in-flight inference. We keep this
 * structural so non-`AgentRuntime` test doubles can satisfy the contract
 * without dragging in the full interface.
 */
export interface AbortableInflightRuntime {
	turnControllers: Pick<
		TurnControllerRegistry,
		"abortAllTurns" | "activeRoomIds"
	>;
}

/**
 * Abort every in-flight inference turn on `runtime`. Used by lifecycle
 * handlers — Wave 3C's `APP_PAUSE_EVENT` listener calls this so the OS
 * pause budget doesn't kill the process while a slow phone-CPU decode is
 * still spinning.
 *
 * Returns the list of room ids that were aborted. Already-aborted or
 * idle turns are skipped, so an empty array means "nothing was running".
 *
 * `reason` is passed through to the `TurnAbortedError` raised inside each
 * in-flight `useModel` / handler path; pick a stable string (e.g. `"app-pause"`,
 * `"container-shutdown"`) so telemetry can group them.
 */
export function abortInflightInference(
	runtime: AbortableInflightRuntime,
	reason = "abort-inflight-inference",
): string[] {
	return runtime.turnControllers.abortAllTurns(reason);
}
