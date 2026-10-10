/** System-owned failure notices remain readable when response generation is unavailable. */
export type SystemNotice =
	| "model-unavailable"
	| "runtime-error"
	| "model-and-runtime-error";

/** Only recognized classifications may bypass conversational rewriting. */
export function readSystemNotice(value: unknown): SystemNotice | undefined {
	return value === "model-unavailable" ||
		value === "runtime-error" ||
		value === "model-and-runtime-error"
		? value
		: undefined;
}

/**
 * Diagnostics stay in runtime logs; owner copy contains only a recovery action.
 * The notice names the running agent (`character.name`), not the framework.
 */
export function systemNoticeText(
	notice: SystemNotice,
	agentName: string | undefined,
): string {
	if (notice === "model-and-runtime-error")
		return `${systemNoticeText("model-unavailable", agentName)}\n---\n${systemNoticeText("runtime-error", agentName)}`;
	const subject = agentName || "This agent";
	return notice === "model-unavailable"
		? `${subject} cannot respond yet. Configure a model provider on the connected host in Settings.`
		: `${subject} needs attention. Check the connected host's diagnostics before trying again.`;
}
