/**
 * Tracks Discord message turns currently being processed by
 * `MessageManager#handleMessage` and the status-reaction controller (if any)
 * each one is driving, so `DiscordService#stop` can wait for outstanding
 * work to finish — bounded — instead of destroying the client mid-turn, and
 * can force-reconcile any status reaction still showing "in progress" when
 * that bound elapses.
 *
 * The two halves are tracked in SEPARATE maps, and each retires on its own
 * completion. An earlier revision kept one entry per turn and retired it only
 * once both halves finished, which coupled the registry's liveness to every
 * caller remembering to drive its controller terminal: one throw that skipped
 * that left the entry resident for the process lifetime, and every later
 * `stop()` then burned the full drain timeout on it. Draining the UNION of
 * both maps keeps the property that motivated the coupling — a turn whose
 * handler has settled while its reaction is still mid-chain is still visible
 * to `drain` — without the shared lifetime (#17749 review, @wtfsayo then
 * @lalalune).
 *
 * `DiscordService#stop` closes the gateway admission gate before calling
 * `drain`, so the snapshot is stable: already-admitted turns may finish while
 * later messageCreate deliveries are rejected observably (#16318).
 */
import type { StatusReactionController } from "./status-reactions";

/**
 * Hard ceiling on how long `DiscordService#stop` waits for in-flight turns
 * to finish before abandoning them. No unbounded wait: a hang here would
 * block process shutdown indefinitely, which is worse than loudly
 * abandoning a turn.
 */
export const DISCORD_SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

/**
 * Second, shorter ceiling on waiting for an ABANDONED reaction to reach its
 * terminal emoji. `abandon()` only enqueues that transition on the controller's
 * serial chain, so returning immediately would let `stop()` destroy the client
 * mid-reconcile — but this path is already the one where something is not
 * finishing, so the wait must be tightly bounded rather than generous.
 */
export const DISCORD_REACTION_RECONCILE_TIMEOUT_MS = 2_000;

export interface DiscordDrainResult {
	/** In-flight turns observed when this `drain` call began. */
	observedCount: number;
	/**
	 * True when the drain bound elapsed with work still outstanding. This is
	 * the ONLY sound signal that the shutdown was not clean: a turn with no
	 * status-reaction controller contributes nothing to `abandonedMessageIds`
	 * however long it hangs, so a caller branching on that array reported a
	 * clean drain for a shutdown that actually timed out and dropped work
	 * (#17749 review, @lalalune).
	 */
	timedOut: boolean;
	/**
	 * Message ids whose HANDLER was still running when the bound elapsed —
	 * work that was dropped. Independent of whether a reaction existed.
	 */
	unfinishedMessageIds: string[];
	/**
	 * Message ids whose status reaction was still non-terminal when the bound
	 * elapsed and was therefore forced to its terminal emoji. A subset of the
	 * turns that had a controller at all, so it is never a proxy for "work was
	 * dropped" — see `unfinishedMessageIds` for that.
	 */
	abandonedMessageIds: string[];
}

export interface DiscordTurnDrainRegistry {
	/** Register an in-flight `handleMessage` call for this message id. */
	trackTurn: (messageId: string, promise: Promise<unknown>) => void;
	/** Attach the status-reaction controller created for a tracked turn. */
	trackStatusReaction: (
		messageId: string,
		controller: StatusReactionController,
	) => void;
	/** Count of message ids with either half still outstanding. */
	pendingCount: () => number;
	/**
	 * Wait for every turn tracked at call time to settle, bounded by
	 * `timeoutMs`. Turns still pending when the bound elapses are abandoned:
	 * their status-reaction controller (if any) is forced to its terminal
	 * state and the message id is reported so the caller can log loudly.
	 * Resolves immediately, without starting the timeout timer, when nothing
	 * is tracked.
	 */
	drain: (timeoutMs: number) => Promise<DiscordDrainResult>;
}

export function createTurnDrainRegistry(): DiscordTurnDrainRegistry {
	const handlers = new Map<string, Promise<unknown>>();
	const reactions = new Map<string, StatusReactionController>();

	const trackTurn = (messageId: string, promise: Promise<unknown>): void => {
		handlers.set(messageId, promise);
		promise
			// error-policy:J5 the real rejection is observed and handled by
			// handleMessage's actual caller (the channel debouncer flush, the
			// per-DM-channel queue, or the direct-dispatch fallback in
			// discord-events.ts, plus the slash-command/interaction dispatch
			// sites). This chain only needs settlement to know the turn is no
			// longer in flight, not the error value.
			.catch(() => undefined)
			.finally(() => {
				// Identity check, not a bare delete: if this message id was
				// re-registered while the older promise was still running, the map
				// now holds the NEWER promise, and retiring on the older one's
				// settlement would drop a turn that is still in flight. Discord
				// message ids are unique so this is not expected, but the previous
				// shape mutated a shared entry object and left the newer turn
				// retirable by the older promise, unguarded (#17749 review).
				if (handlers.get(messageId) === promise) {
					handlers.delete(messageId);
				}
			});
	};

	const trackStatusReaction = (
		messageId: string,
		controller: StatusReactionController,
	): void => {
		reactions.set(messageId, controller);
		controller.whenFinished.then(() => {
			if (reactions.get(messageId) === controller) {
				reactions.delete(messageId);
			}
		});
	};

	const pendingIds = (): string[] => [
		...new Set([...handlers.keys(), ...reactions.keys()]),
	];

	const pendingCount = (): number => pendingIds().length;

	const drain = async (timeoutMs: number): Promise<DiscordDrainResult> => {
		// Snapshot both halves per id. Holding the promise and controller
		// references — rather than re-reading the maps after the race — is what
		// lets the post-timeout pass distinguish "still outstanding" from
		// "retired while we waited" by identity.
		const observed = pendingIds().map((messageId) => ({
			messageId,
			promise: handlers.get(messageId),
			controller: reactions.get(messageId),
		}));
		if (observed.length === 0) {
			return {
				observedCount: 0,
				timedOut: false,
				unfinishedMessageIds: [],
				abandonedMessageIds: [],
			};
		}

		let timedOut = false;
		// Await the status reaction too, not just the handler: resolveFinished()
		// fires inside the controller's serialised chain, so it lands strictly
		// AFTER the handler promise. Awaiting the handler alone would let a fast
		// turn settle the drain while its reaction was still mid-transition, and
		// stop() would then destroy the client on top of a reaction still showing
		// in progress — the exact state this module prevents, reached through the
		// success path instead of the timeout (#17749 review).
		const settleAll = Promise.all(
			observed.map((entry) =>
				Promise.all([
					// error-policy:J5 same reasoning as trackTurn above — the turn's
					// real caller already observes and handles this rejection.
					entry.promise?.catch(() => undefined) ?? Promise.resolve(),
					entry.controller?.whenFinished ?? Promise.resolve(),
				]),
			),
		);
		// The handle must be captured and cleared: an armed Node timer keeps the
		// event loop alive, so a drain that settles promptly would still hold
		// process exit for the full timeout — a shutdown that reads as instant
		// in the logs while the process appears to hang, which is exactly the
		// misdiagnosis this module exists to prevent (#17749 review).
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				timedOut = true;
				resolve();
			}, timeoutMs);
		});
		try {
			await Promise.race([settleAll, timeout]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}

		const unfinishedMessageIds: string[] = [];
		const abandonedMessageIds: string[] = [];
		if (timedOut) {
			const reconciled: Array<Promise<void>> = [];
			for (const entry of observed) {
				// Membership by identity, never `has()`: a half that retired during
				// the wait is genuinely done, and a re-registration under the same
				// id is a different turn that this drain never observed.
				if (
					entry.promise !== undefined &&
					handlers.get(entry.messageId) === entry.promise
				) {
					unfinishedMessageIds.push(entry.messageId);
				}
				const controller = entry.controller;
				if (!controller || reactions.get(entry.messageId) !== controller) {
					continue;
				}
				controller.abandon();
				abandonedMessageIds.push(entry.messageId);
				reconciled.push(controller.whenFinished);
			}
			// `abandon()` only enqueues the terminal transition on the
			// controller's serial chain; the Discord API call is async. Awaiting
			// the resulting `whenFinished` keeps `stop()` from destroying the
			// client mid-reconcile — under its own ceiling, because the whole
			// point of this path is that something is already not finishing.
			if (reconciled.length > 0) {
				await Promise.race([
					Promise.all(reconciled).then(() => undefined),
					new Promise<void>((resolve) => {
						const reconcileTimer = setTimeout(
							resolve,
							DISCORD_REACTION_RECONCILE_TIMEOUT_MS,
						);
						reconcileTimer.unref?.();
					}),
				]);
			}
		}
		return {
			observedCount: observed.length,
			timedOut,
			unfinishedMessageIds,
			abandonedMessageIds,
		};
	};

	return { trackTurn, trackStatusReaction, pendingCount, drain };
}
