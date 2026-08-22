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

interface ActiveTurn {
	roomId: string;
	controller: AbortController;
	startedAt: number;
	reason?: string;
}

// Async-context turn tracking is Node-only, mirroring streaming-context's
// lazy AsyncLocalStorage pattern so the edge bundle carries no node:async_hooks
// import. Without it (non-Node), abortTurn cannot identify the calling turn
// and aborts every turn in the room.
type TurnStorage =
	| import("node:async_hooks").AsyncLocalStorage<ActiveTurn>
	| null;
let currentTurnStorage: TurnStorage = null;
let currentTurnStorageInitialized = false;

function getCurrentTurnStorage(): TurnStorage {
	if (!currentTurnStorageInitialized) {
		currentTurnStorageInitialized = true;
		if (
			typeof process !== "undefined" &&
			typeof process.versions !== "undefined" &&
			typeof process.versions.node !== "undefined"
		) {
			try {
				// eslint-disable-next-line @typescript-eslint/no-require-imports
				const { AsyncLocalStorage } =
					require("node:async_hooks") as typeof import("node:async_hooks");
				currentTurnStorage = new AsyncLocalStorage();
			} catch {
				// error-policy:J4 Turn-context storage is optional outside Node;
				// null explicitly disables in-turn self-exclusion.
				currentTurnStorage = null;
			}
		}
	}
	return currentTurnStorage;
}

export class TurnControllerRegistry {
	private active = new Map<string, ActiveTurn[]>();
	private listeners = new Set<(event: TurnEvent) => void>();

	/**
	 * Run `fn` inside a turn-scoped AbortController. The signal is passed to
	 * `fn` and registered under `roomId` for the duration. When `fn` exits
	 * (normally, throwing, or aborted), the controller is removed from the
	 * registry.
	 *
	 * Concurrent turns for the SAME `roomId` are all tracked. Use
	 * `RoomHandlerQueue` to enforce one-at-a-time per room where needed.
	 */
	async runWith<T>(
		roomId: string,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const controller = new AbortController();
		const turn: ActiveTurn = {
			roomId,
			controller,
			startedAt: Date.now(),
		};
		const turns = this.active.get(roomId) ?? [];
		turns.push(turn);
		this.active.set(roomId, turns);
		this.emit({ type: "started", roomId, startedAt: turn.startedAt });
		const storage = getCurrentTurnStorage();
		try {
			const result = storage
				? await storage.run(turn, () => fn(controller.signal))
				: await fn(controller.signal);
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
			const remaining = (this.active.get(roomId) ?? []).filter(
				(t) => t !== turn,
			);
			if (remaining.length > 0) {
				this.active.set(roomId, remaining);
			} else {
				this.active.delete(roomId);
			}
		}
	}

	/**
	 * Abort the active turns for `roomId`. When called from inside a turn
	 * (async context under `runWith`), that calling turn is excluded — an
	 * abort evaluator kills the work the user wants stopped, not the turn
	 * that is processing the stop request. Out-of-band callers (HTTP stop
	 * route, lifecycle handlers) have no current turn and abort everything.
	 * Returns true if at least one turn was aborted.
	 */
	abortTurn(roomId: string, reason: string): boolean {
		// In-turn callers (threadOps' Stage-1 abort evaluator) are excluded so
		// a cancel message aborts the work the user wants stopped, never the
		// turn processing the cancel. With the previous latest-only map that
		// evaluator could only ever find its own controller and self-aborted
		// (live 2026-08-19: "cancel all ur running coding tasks" → errored
		// turn, nothing delivered).
		const self = getCurrentTurnStorage()?.getStore();
		let aborted = false;
		for (const turn of this.active.get(roomId) ?? []) {
			if (turn === self) continue;
			if (turn.controller.signal.aborted) continue;
			turn.reason = reason;
			turn.controller.abort(new TurnAbortedError(reason));
			aborted = true;
		}
		if (aborted) this.emit({ type: "aborted", roomId, reason });
		return aborted;
	}

	/**
	 * Abort every active turn. Used by lifecycle handlers (APP_PAUSE on
	 * mobile, container shutdown) that need to release all in-flight
	 * inference at once. Returns the room ids that were actually aborted —
	 * already-aborted turns are skipped.
	 */
	abortAllTurns(reason: string): string[] {
		const aborted: string[] = [];
		for (const [roomId, turns] of Array.from(this.active.entries())) {
			let roomAborted = false;
			// Lifecycle shutdown spares nothing — including the caller's own
			// turn, unlike abortTurn's in-turn self-exclusion.
			for (const turn of turns) {
				if (turn.controller.signal.aborted) continue;
				turn.reason = reason;
				turn.controller.abort(new TurnAbortedError(reason));
				roomAborted = true;
			}
			if (roomAborted) {
				this.emit({ type: "aborted", roomId, reason });
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
	 * Inside a turn this is the caller's own signal; out-of-band it is the
	 * newest turn's signal.
	 */
	signalFor(roomId: string): AbortSignal | null {
		const self = getCurrentTurnStorage()?.getStore();
		if (self && self.roomId === roomId) return self.controller.signal;
		const turns = this.active.get(roomId);
		return turns && turns.length > 0
			? turns[turns.length - 1].controller.signal
			: null;
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
