/**
 * Correlates provider-level telemetry with one `AgentRuntime.useModel` dispatch
 * so the generic recorder stays a fallback rather than a duplicate.
 *
 * The per-dispatch counter lives in its own AsyncLocalStorage and never on the
 * trajectory context. `useModel` mints the turn's secret and PII swap sessions
 * by assigning onto the active context object, and the action-execution
 * boundary reads them back off that same object; carrying scope state on a
 * cloned context would strand those writes on a throwaway, so the restore at
 * the boundary would be skipped rather than fail and unresolved placeholders
 * would reach connectors and the user. Keeping the context's identity intact
 * protects `purpose` and `userRole`, which are written the same way.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getTrajectoryContext } from "../trajectory-context";

type LlmCallRecordingScope = {
	acceptedRecords: number;
};

const llmCallRecordingScope = new AsyncLocalStorage<LlmCallRecordingScope>();

export async function runWithLlmCallRecordingScope<T>(
	fn: () => Promise<T> | T,
): Promise<T> {
	// No trajectory context means nothing records, so there is nothing to
	// de-duplicate; keep the fallback recorder's behaviour unchanged.
	if (!getTrajectoryContext()) return fn();
	return llmCallRecordingScope.run({ acceptedRecords: 0 }, fn);
}

export function hasRecordedLlmCallInCurrentScope(): boolean {
	return (llmCallRecordingScope.getStore()?.acceptedRecords ?? 0) > 0;
}

export function noteAcceptedLlmCallRecord(): void {
	const scope = llmCallRecordingScope.getStore();
	if (scope) scope.acceptedRecords += 1;
}
