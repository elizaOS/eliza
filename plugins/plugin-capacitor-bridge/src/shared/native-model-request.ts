/**
 * Builds final-wire admission guards for native mobile text inference.
 * Callers supply the exact model-visible projection they will dispatch; the
 * shared core contract rejects over-budget input before transport and proves
 * every later attempt is byte-identical.
 */

import {
	createPreparedModelRequestGuard,
	type PreparedModelRequestGuard,
} from "@elizaos/core";

export interface NativeModelRequestGuardArgs {
	provider: string;
	model: string;
	contextWindowTokens: number;
	outputReserveTokens: number;
	projectRequest: () => unknown;
	countInputTokens?: (serializedRequest: string) => number;
}

/** Admit one complete native request before any IPC, socket, or FFI attempt. */
export function createNativeModelRequestGuard(
	args: NativeModelRequestGuardArgs,
): PreparedModelRequestGuard {
	return createPreparedModelRequestGuard({
		provider: args.provider,
		model: args.model,
		contextWindowTokens: args.contextWindowTokens,
		outputReserveTokens: args.outputReserveTokens,
		projectRequest: args.projectRequest,
		...(args.countInputTokens
			? { countInputTokens: args.countInputTokens }
			: {}),
	});
}
