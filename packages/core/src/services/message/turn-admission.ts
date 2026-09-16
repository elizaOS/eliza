/** Resolves message-turn admission signals while preserving caller cancellation and preemption. */
import type { ShouldRespondModelType } from "../../types/message-service";

export function mergeAbortSignals(
	signals: Array<AbortSignal | undefined>,
): AbortSignal | undefined {
	const active = signals.filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	const controller = new AbortController();
	const abort = (signal: AbortSignal) => {
		if (!controller.signal.aborted) {
			controller.abort(signal.reason);
		}
	};
	for (const signal of active) {
		if (signal.aborted) {
			abort(signal);
			break;
		}
		signal.addEventListener("abort", () => abort(signal), { once: true });
	}
	return controller.signal;
}

export function normalizeShouldRespondModelType(
	value: unknown,
): ShouldRespondModelType {
	if (typeof value !== "string") {
		return "response-handler";
	}

	const normalized = value.trim().toLowerCase();
	switch (normalized) {
		case "nano":
		case "text_nano":
			return "nano";
		case "small":
		case "text_small":
			return "small";
		case "large":
		case "text_large":
			return "large";
		case "mega":
		case "text_mega":
			return "mega";
		case "response-handler":
		case "response_handler":
		case "responsehandler":
			return "response-handler";
		case "response_handler_model":
			return "response-handler";
		default:
			return "response-handler";
	}
}
