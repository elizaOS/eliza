/**
 * Reserved action-name constants and the canonically ordered
 * `NON_EXECUTABLE_RESPONSE_ACTION_NAMES` set — the response actions
 * (REPLY / NONE / IGNORE) that carry no side-effecting handler.
 */

export const REPLY_ACTION_NAME = "REPLY";
export const NONE_ACTION_NAME = "NONE";
export const IGNORE_ACTION_NAME = "IGNORE";

export const NON_EXECUTABLE_RESPONSE_ACTION_NAMES = [
	REPLY_ACTION_NAME,
	NONE_ACTION_NAME,
	IGNORE_ACTION_NAME,
] as const;
