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

/** Diagnostics stay in runtime logs; owner copy contains only a recovery action. */
export function systemNoticeText(notice: SystemNotice): string {
	if (notice === "model-and-runtime-error")
		return `${systemNoticeText("model-unavailable")}\n---\n${systemNoticeText("runtime-error")}`;
	return notice === "model-unavailable"
		? "Eliza cannot respond yet. Configure a model provider on the connected host in Settings."
		: "Eliza needs attention. Check the connected host's diagnostics before trying again.";
}
