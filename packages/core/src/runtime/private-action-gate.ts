import type { Action } from "../types/components";
import type { Memory } from "../types/memory";

/**
 * "Private" actions (see {@link Action.private}) may only run inside the
 * agent's own autonomous loop, never in direct response to a user request.
 *
 * A turn is treated as autonomous when the triggering message carries
 * `content.metadata.isAutonomous === true` — the marker the autonomy service
 * stamps on its self-prompts. Any other message (a real user turn, a connector
 * inbound, a sub-agent dispatch) is non-autonomous and a private action must be
 * withheld.
 *
 * The marker is trustworthy here because inbound messages are stripped of a
 * forged `isAutonomous` upstream: `hardenIncomingUserMessage`
 * (security/incoming-message-security.ts, #12087 Item 7) removes it from every
 * message whose source is not the autonomy service, so a connector forwarding
 * client-supplied metadata cannot use it to unlock private actions.
 */
export function isAutonomousTurn(message: Memory | undefined): boolean {
	const metadata = message?.content?.metadata;
	if (typeof metadata !== "object" || metadata === null) {
		return false;
	}
	return (metadata as { isAutonomous?: unknown }).isAutonomous === true;
}

/**
 * Returns true when `action` is allowed to be exposed/executed on the current
 * turn given its private-mode flag. Private actions are allowed only on
 * autonomous turns; non-private actions are always allowed.
 */
export function privateActionAllowedOnTurn(
	action: Pick<Action, "private">,
	message: Memory | undefined,
): boolean {
	if (!action.private) {
		return true;
	}
	return isAutonomousTurn(message);
}
