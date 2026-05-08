import type { IAgentRuntime } from "@elizaos/core";
import { BLUESKY_SERVICE_URL } from "./types";

export const DEFAULT_BLUESKY_ACCOUNT_ID = "default";

export interface BlueSkyAccountConfig {
	accountId?: string;
	id?: string;
	handle?: string;
	password?: string;
	service?: string;
	dryRun?: boolean | string;
	pollInterval?: number | string;
	enablePost?: boolean | string;
	postIntervalMin?: number | string;
	postIntervalMax?: number | string;
	enableActionProcessing?: boolean | string;
	actionInterval?: number | string;
	postImmediately?: boolean | string;
	maxActionsProcessing?: number | string;
	enableDMs?: boolean | string;
	enabled?: boolean;
	label?: string;
}

interface BlueSkyMultiAccountConfig extends BlueSkyAccountConfig {
	accounts?: Record<string, BlueSkyAccountConfig>;
}

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const value = runtime.getSetting(key);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): BlueSkyMultiAccountConfig {
	const settings = runtime.character?.settings as
		| Record<string, unknown>
		| undefined;
	const raw = settings?.bluesky;
	return raw && typeof raw === "object"
		? (raw as BlueSkyMultiAccountConfig)
		: {};
}

function parseAccountsJson(
	runtime: IAgentRuntime,
): Record<string, BlueSkyAccountConfig> {
	const raw = stringSetting(runtime, "BLUESKY_ACCOUNTS");
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return Object.fromEntries(
				parsed
					.filter(
						(item): item is BlueSkyAccountConfig =>
							Boolean(item) && typeof item === "object",
					)
					.map((item) => [
						normalizeBlueSkyAccountId(item.accountId ?? item.id ?? item.handle),
						item,
					]),
			);
		}
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, BlueSkyAccountConfig>)
			: {};
	} catch {
		return {};
	}
}

function allAccountConfigs(
	runtime: IAgentRuntime,
): Record<string, BlueSkyAccountConfig> {
	return {
		...(characterConfig(runtime).accounts ?? {}),
		...parseAccountsJson(runtime),
	};
}

function accountConfig(
	runtime: IAgentRuntime,
	accountId: string,
): BlueSkyAccountConfig {
	const accounts = allAccountConfigs(runtime);
	return (
		accounts[accountId] ??
		accounts[normalizeBlueSkyAccountId(accountId)] ??
		{}
	);
}

export function normalizeBlueSkyAccountId(accountId?: unknown): string {
	if (typeof accountId !== "string") return DEFAULT_BLUESKY_ACCOUNT_ID;
	const trimmed = accountId.trim();
	return trimmed || DEFAULT_BLUESKY_ACCOUNT_ID;
}

export function listBlueSkyAccountIds(runtime: IAgentRuntime): string[] {
	const ids = new Set<string>();
	const config = characterConfig(runtime);

	if (stringSetting(runtime, "BLUESKY_HANDLE") || config.handle) {
		ids.add(DEFAULT_BLUESKY_ACCOUNT_ID);
	}
	for (const id of Object.keys(allAccountConfigs(runtime))) {
		ids.add(normalizeBlueSkyAccountId(id));
	}
	if (ids.size === 0) ids.add(DEFAULT_BLUESKY_ACCOUNT_ID);
	return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultBlueSkyAccountId(runtime: IAgentRuntime): string {
	const requested =
		stringSetting(runtime, "BLUESKY_DEFAULT_ACCOUNT_ID") ??
		stringSetting(runtime, "BLUESKY_ACCOUNT_ID");
	if (requested) return normalizeBlueSkyAccountId(requested);
	const ids = listBlueSkyAccountIds(runtime);
	return ids.includes(DEFAULT_BLUESKY_ACCOUNT_ID)
		? DEFAULT_BLUESKY_ACCOUNT_ID
		: (ids[0] ?? DEFAULT_BLUESKY_ACCOUNT_ID);
}

export function readBlueSkyAccountId(
	...sources: unknown[]
): string | undefined {
	for (const source of sources) {
		if (!source || typeof source !== "object") continue;
		const record = source as Record<string, unknown>;
		const parameters =
			record.parameters && typeof record.parameters === "object"
				? (record.parameters as Record<string, unknown>)
				: {};
		const data =
			record.data && typeof record.data === "object"
				? (record.data as Record<string, unknown>)
				: {};
		const metadata =
			record.metadata && typeof record.metadata === "object"
				? (record.metadata as Record<string, unknown>)
				: {};
		const bluesky =
			data.bluesky && typeof data.bluesky === "object"
				? (data.bluesky as Record<string, unknown>)
				: {};
		const value =
			record.accountId ??
			parameters.accountId ??
			data.accountId ??
			bluesky.accountId ??
			metadata.accountId;
		if (typeof value === "string" && value.trim())
			return normalizeBlueSkyAccountId(value);
	}
	return undefined;
}

function boolValue(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
	return fallback;
}

function numberValue(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return fallback;
}

/**
 * Resolve concrete config values for a specific BlueSky account, falling back
 * to character settings, then to env-style runtime settings (only for the
 * default account so legacy single-account env-only deploys keep working).
 */
export function resolveBlueSkyAccountConfig(
	runtime: IAgentRuntime,
	requestedAccountId?: string | null,
): {
	accountId: string;
	handle: string;
	password: string;
	service: string;
	dryRun: boolean;
	pollInterval: number;
	enablePost: boolean;
	postIntervalMin: number;
	postIntervalMax: number;
	enableActionProcessing: boolean;
	actionInterval: number;
	postImmediately: boolean;
	maxActionsProcessing: number;
	enableDMs: boolean;
} {
	const accountId = normalizeBlueSkyAccountId(
		requestedAccountId ?? resolveDefaultBlueSkyAccountId(runtime),
	);
	const base = characterConfig(runtime);
	const account = accountConfig(runtime, accountId);
	const allowEnv = accountId === DEFAULT_BLUESKY_ACCOUNT_ID;

	const handle =
		account.handle ??
		base.handle ??
		(allowEnv ? stringSetting(runtime, "BLUESKY_HANDLE") : undefined) ??
		"";
	const password =
		account.password ??
		base.password ??
		(allowEnv ? stringSetting(runtime, "BLUESKY_PASSWORD") : undefined) ??
		"";
	const service =
		account.service ??
		base.service ??
		(allowEnv ? stringSetting(runtime, "BLUESKY_SERVICE") : undefined) ??
		BLUESKY_SERVICE_URL;

	return {
		accountId,
		handle,
		password,
		service,
		dryRun: boolValue(
			account.dryRun ??
				base.dryRun ??
				(allowEnv ? stringSetting(runtime, "BLUESKY_DRY_RUN") : undefined),
			false,
		),
		pollInterval: numberValue(
			account.pollInterval ??
				base.pollInterval ??
				(allowEnv ? stringSetting(runtime, "BLUESKY_POLL_INTERVAL") : undefined),
			60,
		),
		enablePost: boolValue(
			account.enablePost ??
				base.enablePost ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_ENABLE_POSTING") !== "false"
						? true
						: false
					: undefined),
			true,
		),
		postIntervalMin: numberValue(
			account.postIntervalMin ??
				base.postIntervalMin ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_POST_INTERVAL_MIN")
					: undefined),
			1800,
		),
		postIntervalMax: numberValue(
			account.postIntervalMax ??
				base.postIntervalMax ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_POST_INTERVAL_MAX")
					: undefined),
			3600,
		),
		enableActionProcessing: boolValue(
			account.enableActionProcessing ??
				base.enableActionProcessing ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_ENABLE_ACTION_PROCESSING") !==
						"false"
						? true
						: false
					: undefined),
			true,
		),
		actionInterval: numberValue(
			account.actionInterval ??
				base.actionInterval ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_ACTION_INTERVAL")
					: undefined),
			120,
		),
		postImmediately: boolValue(
			account.postImmediately ??
				base.postImmediately ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_POST_IMMEDIATELY")
					: undefined),
			false,
		),
		maxActionsProcessing: numberValue(
			account.maxActionsProcessing ??
				base.maxActionsProcessing ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_MAX_ACTIONS_PROCESSING")
					: undefined),
			5,
		),
		enableDMs: boolValue(
			account.enableDMs ??
				base.enableDMs ??
				(allowEnv
					? stringSetting(runtime, "BLUESKY_ENABLE_DMS") !== "false"
						? true
						: false
					: undefined),
			true,
		),
	};
}
