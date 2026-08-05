/**
 * Tracks Discord message turns currently being processed by
 * `MessageManager#handleMessage` and the status-reaction controller (if any)
 * each one is driving, so `DiscordService#stop` can wait for outstanding
 * work to finish — bounded — instead of destroying the client mid-turn, and
 * can force-reconcile any status reaction still showing "in progress" when
 * that bound elapses.
 *
 * Scope note: this registry drains turns that were already in flight when
 * `drain` is called. It does not stop new inbound messages from starting a
 * new turn while the drain is in progress — discord.js keeps delivering
 * gateway events until the client is destroyed, and this connector has no
 * ingress cordon (elizaOS/eliza#16318 scopes an inbound cordon to the
 * runtime-level shutdown path, outside this plugin). A turn that starts
 * after `drain` begins is not covered by that call.
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

interface TrackedTurn {
	promise: Promise<unknown>;
	statusReactions: StatusReactionController | null;
	/** The handler promise has settled (resolved or rejected). */
	handlerSettled: boolean;
	/** The status reaction reached a terminal state, or there is none to reach. */
	reactionSettled: boolean;
}

export interface DiscordDrainResult {
	/** In-flight turns observed when this `drain` call began. */
	observedCount: number;
	/** Message ids still in flight when the drain timeout elapsed. */
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
	/** Count of turns currently tracked as in flight. */
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
	const turns = new Map<string, TrackedTurn>();

	// A turn leaves the registry only when BOTH halves are done: the handler has
	// settled AND its status reaction reached a terminal state. Retiring on the
	// handler alone removed the entry while its reaction was still mid-chain, so
	// a drain running in that window never saw the turn at all — it reported the
	// success path and left the reaction stranded in-progress, which is the
	// exact state this module exists to prevent (#17749 review, @wtfsayo).
	const untrackIfComplete = (messageId: string, entry: TrackedTurn): void => {
		if (!entry.handlerSettled || !entry.reactionSettled) return;
		if (turns.get(messageId) === entry) {
			turns.delete(messageId);
		}
	};

	const trackTurn = (messageId: string, promise: Promise<unknown>): void => {
		// Reuse the existing record if `trackStatusReaction` already claimed
		// this message id, so both settle listeners below close over the same
		// object and either one can retire it.
		const entry = turns.get(messageId) ?? {
			promise,
			statusReactions: null,
			handlerSettled: false,
			// No controller registered means there is no reaction to reconcile;
			// trackStatusReaction flips this back when one arrives.
			reactionSettled: true,
		};
		entry.promise = promise;
		entry.handlerSettled = false;
		turns.set(messageId, entry);
		promise
			// error-policy:J5 the real rejection is observed and handled by
			// handleMessage's actual caller (the channel debouncer flush, the
			// per-DM-channel queue, or the direct-dispatch fallback in
			// discord-events.ts, plus the slash-command/interaction dispatch
			// sites). This chain only needs settlement to know the turn is no
			// longer in flight, not the error value.
			.catch(() => undefined)
			.finally(() => {
				entry.handlerSettled = true;
				untrackIfComplete(messageId, entry);
			});
	};

	const trackStatusReaction = (
		messageId: string,
		controller: StatusReactionController,
	): void => {
		const entry = turns.get(messageId) ?? {
			promise: Promise.resolve(),
			statusReactions: controller,
			// A reaction registered before its turn: the handler half is not
			// outstanding until trackTurn supplies one.
			handlerSettled: true,
			reactionSettled: false,
		};
		entry.statusReactions = controller;
		entry.reactionSettled = false;
		turns.set(messageId, entry);
		controller.whenFinished.then(() => {
			entry.reactionSettled = true;
			untrackIfComplete(messageId, entry);
		});
	};

	const pendingCount = (): number => turns.size;

	const drain = async (timeoutMs: number): Promise<DiscordDrainResult> => {
		const entries = [...turns.entries()];
		if (entries.length === 0) {
			return { observedCount: 0, abandonedMessageIds: [] };
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
			entries.map(([, entry]) =>
				Promise.all([
					// error-policy:J5 same reasoning as trackTurn above — the turn's
					// real caller already observes and handles this rejection.
					entry.promise.catch(() => undefined),
					entry.statusReactions?.whenFinished ?? Promise.resolve(),
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

		const abandonedMessageIds: string[] = [];
		if (timedOut) {
			// Decide from the SNAPSHOT and from the reaction's own state, never
			// from `turns.has()`: the handler's `finally` untracks the entry as
			// soon as the handler settles, so a turn whose handler finished
			// while its reaction was still mid-chain is already gone from the
			// map by the time the timeout fires. Gating on membership therefore
			// skipped exactly the case that needs reconciling — leaving an
			// in-progress reaction stranded AND reporting the success path,
			// because `abandonedMessageIds` came back empty (#17749 review,
			// @wtfsayo).
			const reconciled: Array<Promise<void>> = [];
			for (const [messageId, entry] of entries) {
				const reactions = entry.statusReactions;
				if (!reactions || entry.reactionSettled) continue;
				reactions.abandon();
				abandonedMessageIds.push(messageId);
				reconciled.push(reactions.whenFinished);
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
		return { observedCount: entries.length, abandonedMessageIds };
	};

	return { trackTurn, trackStatusReaction, pendingCount, drain };
}
