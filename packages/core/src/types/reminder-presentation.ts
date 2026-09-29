import { getAmbientSingleton } from "../ambient-context";
import { ElizaError } from "../errors";
/** Process-local authority for a saved reminder's exact presentation. Never accepted from JSON. */
export type ReminderPresentation = {
	readonly kind: "saved-one-shot-reminder";
	readonly body: string;
	readonly chatText: string;
	readonly title: string;
};
const registryKey = Symbol.for("eliza.saved-reminder-presentation.authority");
const issued = () =>
	getAmbientSingleton(registryKey, () => new WeakSet<object>());
export function createReminderPresentation(
	body: string,
	chatText: string,
	title: string,
): ReminderPresentation {
	if (!body.trim() || !title.trim() || !chatText.startsWith(body))
		throw new ElizaError("Invalid saved reminder presentation", {
			code: "REMINDER_PRESENTATION_INVALID",
		});
	const value = Object.freeze({
		kind: "saved-one-shot-reminder" as const,
		body,
		chatText,
		title,
	});
	issued().add(value);
	return value;
}
export function readReminderPresentation(
	value: unknown,
): ReminderPresentation | null {
	return typeof value === "object" && value !== null && issued().has(value)
		? (value as ReminderPresentation)
		: null;
}
