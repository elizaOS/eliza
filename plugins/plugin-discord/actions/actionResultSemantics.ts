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
