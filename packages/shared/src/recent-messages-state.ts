import type { Memory, State } from "@elizaos/core";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object") {
		return null;
	}

	return value as Record<string, unknown>;
}

function isMemoryArray(value: unknown): value is Memory[] {
	return (
		Array.isArray(value) &&
		value.every((item) => Boolean(item) && typeof item === "object")
	);
}

export function getRecentMessagesData(state: State | undefined): Memory[] {
	if (!state || typeof state !== "object") {
		return [];
	}

	const stateRecord = state as Record<string, unknown>;
	const data = asRecord(stateRecord.data);
	const providerResults = asRecord(data?.providers);
	const providerRecentMessages = asRecord(providerResults?.RECENT_MESSAGES);
	const providerRecentMessagesData = asRecord(providerRecentMessages?.data);

	const recentMessages = [
		providerRecentMessagesData?.recentMessages,
		data?.recentMessages,
		stateRecord.recentMessagesData,
		stateRecord.recentMessages,
	].find(isMemoryArray);

	return recentMessages ?? [];
}
