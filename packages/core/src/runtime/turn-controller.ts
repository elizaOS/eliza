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

export class TurnControllerRegistry {
	private active = new Map<string, ActiveTurn>();
	private listeners = new Set<(event: TurnEvent) => void>();

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
		const turn: ActiveTurn = {
			roomId,
			controller,
			startedAt: Date.now(),
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
