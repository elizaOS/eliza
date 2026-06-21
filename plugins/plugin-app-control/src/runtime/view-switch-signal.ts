/**
 * @module plugin-app-control/runtime/view-switch-signal
 * @description Process-local, turn-scoped "a view switch just happened in this
 * room" signal.
 *
 * This is NOT a second view-state store — the authoritative current-view state
 * (and its `switchedAt`/`source` stamp) lives server-side in `@elizaos/agent`'s
 * `currentViewState`, read by the `current_view` provider over loopback. This
 * module only records the *fact* that the agent navigated very recently, keyed
 * by room, so the `compose_state_providers` hook can decide — synchronously, with
 * no extra loopback on every turn — whether to inject the `current_view`
 * acknowledgement provider into the curated Stage-1 response state.
 *
 * Set by the navigate paths (`runViewsShow`, the contextual evaluator's
 * processor) right after a successful navigate; read by the compose hook.
 */

/** A recorded switch is considered fresh for this long (covers same + next turn). */
export const VIEW_SWITCH_SIGNAL_FRESH_MS = 15_000;

const recentSwitches = new Map<string, number>();

/** Record that the agent just navigated the given room to a new view. */
export function markViewSwitch(
	roomId: string | undefined,
	now: number = Date.now(),
): void {
	if (!roomId) return;
	recentSwitches.set(roomId, now);
}

/** True when a switch was recorded for `roomId` within the freshness window. */
export function hasFreshViewSwitch(
	roomId: string | undefined,
	now: number = Date.now(),
): boolean {
	if (!roomId) return false;
	const at = recentSwitches.get(roomId);
	if (at === undefined) return false;
	if (now - at > VIEW_SWITCH_SIGNAL_FRESH_MS) {
		recentSwitches.delete(roomId);
		return false;
	}
	return true;
}

/** Drop the recorded switch for `roomId` (after it has been acknowledged). */
export function clearViewSwitch(roomId: string | undefined): void {
	if (roomId) recentSwitches.delete(roomId);
}

/** Test-only: reset all recorded switches. */
export function __resetViewSwitchSignal(): void {
	recentSwitches.clear();
}
