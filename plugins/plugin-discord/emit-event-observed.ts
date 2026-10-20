import type { EventPayload, IAgentRuntime } from "@elizaos/core";

/**
 * Emits an event for a caller that has already finished its own work.
 *
 * A listener that throws or rejects must not escape as an unhandled
 * rejection: the work that triggered the event is already done, so the
 * failure belongs in diagnostics, not in the process rejection handler.
 */
export function emitEventObserved(
	runtime: IAgentRuntime,
	eventName: string | string[],
	payload: EventPayload,
): void {
	const reportFailure = (error: unknown): void => {
		runtime.reportError("discord:emit-event", error, {
			eventName: Array.isArray(eventName) ? eventName.join(",") : eventName,
		});
	};
	try {
		void Promise.resolve(runtime.emitEvent(eventName, payload)).catch(
			reportFailure,
		);
	} catch (error) {
		reportFailure(error);
	}
}
