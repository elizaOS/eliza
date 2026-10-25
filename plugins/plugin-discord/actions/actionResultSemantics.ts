/**
 * Action-result semantics for terminal Discord interactions — flags that
 * suppress post-action continuation so a completed interaction does not trigger
 * a further agent turn.
 */
import type { ActionResult } from "@elizaos/core";

type ActionResultData = NonNullable<ActionResult["data"]>;

export const terminalActionInteractionSemantics = {
	suppressPostActionContinuation: true,
	suppressActionResultClipboard: true,
} as const;

export function terminalActionResultData(
	data: ActionResultData = {},
): ActionResultData {
	return {
		...data,
		suppressVisibleCallback: true,
		suppressActionResultClipboard: true,
	};
}
