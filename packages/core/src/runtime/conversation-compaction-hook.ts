import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

export const MESSAGE_HISTORY_COMPACTION_HOOK = Symbol.for(
	"elizaos.messageHistoryCompactionHook",
);

export interface MessageHistoryCompactionTelemetry {
	source: "message-history";
	didCompact: boolean;
	strategy: string | null;
	thresholdTokens: number;
	targetTokens: number;
	originalTokens: number;
	compactedTokens: number;
	originalMessageCount: number;
	compactedMessageCount: number;
	preserveTailMessages: number;
	latencyMs: number;
	skipReason?: string;
	replacementMessageCount?: number;
	conversationKey?: string;
}

export interface MessageHistoryCompactionHookArgs {
	runtime: IAgentRuntime;
	message: Memory;
	state: State;
	source:
		| "compose-response-state"
		| "provider-grounded-state"
		| "continuation-state";
}

export interface MessageHistoryCompactionHookResult {
	state: State;
	telemetry?: MessageHistoryCompactionTelemetry;
}

export type MessageHistoryCompactionHook = (
	args: MessageHistoryCompactionHookArgs,
) => Promise<MessageHistoryCompactionHookResult | null | undefined>;

export type RuntimeWithMessageHistoryCompactionHook = IAgentRuntime & {
	[MESSAGE_HISTORY_COMPACTION_HOOK]?: MessageHistoryCompactionHook;
};

export function registerMessageHistoryCompactionHook(
	runtime: IAgentRuntime,
	hook: MessageHistoryCompactionHook | null,
): void {
	const target = runtime as RuntimeWithMessageHistoryCompactionHook;
	if (hook) {
		target[MESSAGE_HISTORY_COMPACTION_HOOK] = hook;
		return;
	}
	delete target[MESSAGE_HISTORY_COMPACTION_HOOK];
}

export function getMessageHistoryCompactionHook(
	runtime: IAgentRuntime,
): MessageHistoryCompactionHook | null {
	const hook = (runtime as RuntimeWithMessageHistoryCompactionHook)[
		MESSAGE_HISTORY_COMPACTION_HOOK
	];
	return typeof hook === "function" ? hook : null;
}
