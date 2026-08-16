/**
 * Reserved action-name constants and the canonically ordered
 * `NON_EXECUTABLE_RESPONSE_ACTION_NAMES` set — the response actions
 * (REPLY / NONE / IGNORE) that carry no side-effecting handler.
 */

export const REPLY_ACTION_NAME = "REPLY";
export const NONE_ACTION_NAME = "NONE";
export const IGNORE_ACTION_NAME = "IGNORE";
export const STOP_ACTION_NAME = "STOP";

export const NON_EXECUTABLE_RESPONSE_ACTION_NAMES = [
	REPLY_ACTION_NAME,
	NONE_ACTION_NAME,
	IGNORE_ACTION_NAME,
] as const;

/**
 * Protocol names that are not completed tools. Continuation resolution must
 * agree with the planner: REPLY/NONE/IGNORE are the exported non-executable
 * envelope, and STOP is the extra planner terminal
 * (`isTerminalPlannerToolName`) — not a side-effecting result.
 */
export function isReservedNonToolActionName(name: string): boolean {
	const normalized = name.toUpperCase().replace(/_/g, "");
	if (
		(NON_EXECUTABLE_RESPONSE_ACTION_NAMES as readonly string[]).some(
			(entry) => entry.toUpperCase().replace(/_/g, "") === normalized,
		)
	) {
		return true;
	}
	return normalized === STOP_ACTION_NAME;
}
