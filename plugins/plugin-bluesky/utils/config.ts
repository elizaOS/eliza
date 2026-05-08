import type { IAgentRuntime } from "@elizaos/core";
import {
	DEFAULT_BLUESKY_ACCOUNT_ID,
	listBlueSkyAccountIds as listBlueSkyAccountIdsImpl,
	normalizeBlueSkyAccountId,
	readBlueSkyAccountId,
	resolveBlueSkyAccountConfig,
	resolveDefaultBlueSkyAccountId as resolveDefaultBlueSkyAccountIdImpl,
} from "../accounts";
import {
	BLUESKY_ACTION_INTERVAL,
	BLUESKY_MAX_ACTIONS,
	BLUESKY_POLL_INTERVAL,
	BLUESKY_POST_INTERVAL_MAX,
	BLUESKY_POST_INTERVAL_MIN,
	BLUESKY_SERVICE_URL,
	type BlueSkyConfig,
	BlueSkyConfigSchema,
} from "../types";

export type { BlueSkyConfig };
export {
	DEFAULT_BLUESKY_ACCOUNT_ID,
	normalizeBlueSkyAccountId,
	readBlueSkyAccountId,
};

export function getApiKeyOptional(
	runtime: IAgentRuntime,
	key: string,
): string | undefined {
	const value = runtime.getSetting(key);
	return typeof value === "string" ? value : undefined;
}

export function listBlueSkyAccountIds(runtime: IAgentRuntime): string[] {
	return listBlueSkyAccountIdsImpl(runtime);
}

export function resolveDefaultBlueSkyAccountId(
	runtime: IAgentRuntime,
): string {
	return resolveDefaultBlueSkyAccountIdImpl(runtime);
}

export function hasBlueSkyEnabled(runtime: IAgentRuntime): boolean {
	const enabled = runtime.getSetting("BLUESKY_ENABLED");
	if (enabled) return String(enabled).toLowerCase() === "true";
	const ids = listBlueSkyAccountIds(runtime);
	for (const id of ids) {
		const resolved = resolveBlueSkyAccountConfig(runtime, id);
		if (resolved.handle && resolved.password) return true;
	}
	return false;
}

export function validateBlueSkyConfig(
	runtime: IAgentRuntime,
	requestedAccountId?: string | null,
): BlueSkyConfig & { accountId: string } {
	const resolved = resolveBlueSkyAccountConfig(runtime, requestedAccountId);
	const result = BlueSkyConfigSchema.safeParse({
		handle: resolved.handle,
		password: resolved.password,
		service: resolved.service || BLUESKY_SERVICE_URL,
		dryRun: resolved.dryRun,
		pollInterval: resolved.pollInterval || BLUESKY_POLL_INTERVAL,
		enablePost: resolved.enablePost,
		postIntervalMin: resolved.postIntervalMin || BLUESKY_POST_INTERVAL_MIN,
		postIntervalMax: resolved.postIntervalMax || BLUESKY_POST_INTERVAL_MAX,
		enableActionProcessing: resolved.enableActionProcessing,
		actionInterval: resolved.actionInterval || BLUESKY_ACTION_INTERVAL,
		postImmediately: resolved.postImmediately,
		maxActionsProcessing: resolved.maxActionsProcessing || BLUESKY_MAX_ACTIONS,
		enableDMs: resolved.enableDMs,
	});

	if (!result.success) {
		const errors =
			(
				result.error as { errors?: { path: string[]; message: string }[] }
			).errors
				?.map((e) => `${e.path.join(".")}: ${e.message}`)
				.join(", ") || result.error.toString();
		throw new Error(`Invalid BlueSky configuration: ${errors}`);
	}

	return { ...result.data, accountId: resolved.accountId };
}

export function getPollInterval(
	runtime: IAgentRuntime,
	accountId?: string,
): number {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	return (resolved.pollInterval || BLUESKY_POLL_INTERVAL) * 1000;
}

export function getActionInterval(
	runtime: IAgentRuntime,
	accountId?: string,
): number {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	return (resolved.actionInterval || BLUESKY_ACTION_INTERVAL) * 1000;
}

export function getMaxActionsProcessing(
	runtime: IAgentRuntime,
	accountId?: string,
): number {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	return resolved.maxActionsProcessing || BLUESKY_MAX_ACTIONS;
}

export function isPostingEnabled(
	runtime: IAgentRuntime,
	accountId?: string,
): boolean {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	return resolved.enablePost;
}

export function shouldPostImmediately(
	runtime: IAgentRuntime,
	accountId?: string,
): boolean {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	return resolved.postImmediately;
}

export function getPostIntervalRange(
	runtime: IAgentRuntime,
	accountId?: string,
): {
	min: number;
	max: number;
} {
	const resolved = resolveBlueSkyAccountConfig(runtime, accountId);
	const min = resolved.postIntervalMin || BLUESKY_POST_INTERVAL_MIN;
	const max = resolved.postIntervalMax || BLUESKY_POST_INTERVAL_MAX;
	return { min: min * 1000, max: max * 1000 };
}
