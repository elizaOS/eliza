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

interface TrackedTurn {
	promise: Promise<unknown>;
	statusReactions: StatusReactionController | null;
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

	const untrack = (messageId: string, entry: TrackedTurn): void => {
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
		};
		entry.promise = promise;
		turns.set(messageId, entry);
		promise
			// error-policy:J5 the real rejection is observed and handled by
			// handleMessage's actual caller (the channel debouncer flush, the
			// per-DM-channel queue, or the direct-dispatch fallback in
			// discord-events.ts, plus the slash-command/interaction dispatch
			// sites). This chain only needs settlement to know the turn is no
			// longer in flight, not the error value.
			.catch(() => undefined)
			.finally(() => untrack(messageId, entry));
	};

	const trackStatusReaction = (
		messageId: string,
		controller: StatusReactionController,
	): void => {
		const entry = turns.get(messageId) ?? {
			promise: Promise.resolve(),
			statusReactions: controller,
		};
		entry.statusReactions = controller;
		turns.set(messageId, entry);
		controller.whenFinished.then(() => untrack(messageId, entry));
	};

	const pendingCount = (): number => turns.size;

	const drain = async (timeoutMs: number): Promise<DiscordDrainResult> => {
		const entries = [...turns.entries()];
		if (entries.length === 0) {
			return { observedCount: 0, abandonedMessageIds: [] };
		}

		let timedOut = false;
		const settleAll = Promise.all(
			entries.map(([, entry]) =>
				// error-policy:J5 same reasoning as trackTurn above — the turn's
				// real caller already observes and handles this rejection.
				entry.promise.catch(() => undefined),
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
			for (const [messageId, entry] of entries) {
				if (turns.has(messageId)) {
					entry.statusReactions?.abandon();
					abandonedMessageIds.push(messageId);
				}
			}
		}
		return { observedCount: entries.length, abandonedMessageIds };
	};

	return { trackTurn, trackStatusReaction, pendingCount, drain };
}
