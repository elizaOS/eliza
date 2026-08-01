/**
 * Correlates provider-level telemetry with one `AgentRuntime.useModel` dispatch
 * so the generic recorder remains a fallback rather than a duplicate. The
 * cloned trajectory context isolates simultaneous calls in AsyncLocalStorage.
 */

import type { TrajectoryContext } from "../trajectory-context";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../trajectory-context";

const LLM_CALL_RECORDING_SCOPE_KEY = Symbol.for(
	"elizaos.llmCallRecordingScope",
);

type LlmCallRecordingScope = {
	acceptedRecords: number;
};

type ScopedTrajectoryContext = TrajectoryContext & {
	[LLM_CALL_RECORDING_SCOPE_KEY]?: LlmCallRecordingScope;
};

export async function runWithLlmCallRecordingScope<T>(
	fn: () => Promise<T> | T,
): Promise<T> {
	const active = getTrajectoryContext();
	if (!active) return fn();

	const child: ScopedTrajectoryContext = {
		...active,
		[LLM_CALL_RECORDING_SCOPE_KEY]: { acceptedRecords: 0 },
	};
	return runWithTrajectoryContext(child, fn);
}

export function hasRecordedLlmCallInCurrentScope(): boolean {
	const context = getTrajectoryContext() as ScopedTrajectoryContext | undefined;
	return (context?.[LLM_CALL_RECORDING_SCOPE_KEY]?.acceptedRecords ?? 0) > 0;
}

export function noteAcceptedLlmCallRecord(): void {
	const context = getTrajectoryContext() as ScopedTrajectoryContext | undefined;
	const scope = context?.[LLM_CALL_RECORDING_SCOPE_KEY];
	if (scope) scope.acceptedRecords += 1;
}
