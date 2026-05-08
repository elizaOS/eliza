import type { IAgentRuntime } from "@elizaos/core";
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
export type ResolvedBlueSkyConfig = BlueSkyConfig & { accountId: string };

export const DEFAULT_BLUESKY_ACCOUNT_ID = "default";

type RawBlueSkyAccountConfig = Partial<BlueSkyConfig> &
	Record<string, unknown> & {
		accountId?: string;
		id?: string;
	};

type BlueSkyMultiAccountConfig = RawBlueSkyAccountConfig & {
	accounts?: Record<string, RawBlueSkyAccountConfig>;
};

export function getApiKeyOptional(
	runtime: IAgentRuntime,
	key: string,
): string | undefined {
	const value = runtime.getSetting(key);
	return typeof value === "string" ? value : undefined;
}

function stringSetting(runtime: IAgentRuntime, key: string): string | undefined {
	const value = runtime.getSetting(key);
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function characterConfig(runtime: IAgentRuntime): BlueSkyMultiAccountConfig {
	const settings = runtime.character?.settings as Record<string, unknown> | undefined;
	const raw = settings?.bluesky;
	return raw && typeof raw === "object" ? (raw as BlueSkyMultiAccountConfig) : {};
}

function parseAccountsJson(runtime: IAgentRuntime): Record<string, RawBlueSkyAccountConfig> {
	const raw = stringSetting(runtime, "BLUESKY_ACCOUNTS");
	if (!raw) return {};

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (Array.isArray(parsed)) {
			return Object.fromEntries(
				parsed
					.filter(
						(item): item is RawBlueSkyAccountConfig =>
							Boolean(item) && typeof item === "object",
					)
					.map((item) => [normalizeBlueSkyAccountId(item.accountId ?? item.id), item]),
			);
		}
		return parsed && typeof parsed === "object"
			? (parsed as Record<string, RawBlueSkyAccountConfig>)
			: {};
	} catch {
		return {};
	}
}

function allAccountConfigs(runtime: IAgentRuntime): Record<string, RawBlueSkyAccountConfig> {
	return {
		...(characterConfig(runtime).accounts ?? {}),
		...parseAccountsJson(runtime),
	};
}

function accountConfig(
	runtime: IAgentRuntime,
	accountId: string,
): RawBlueSkyAccountConfig {
	const accounts = allAccountConfigs(runtime);
	return accounts[accountId] ?? accounts[normalizeBlueSkyAccountId(accountId)] ?? {};
}

function readRawField(
	record: RawBlueSkyAccountConfig | undefined,
	keys: string[],
): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" || typeof value === "boolean") return String(value);
	}
	return undefined;
}

function boolValue(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value.trim().toLowerCase() === "true";
	return fallback;
}

function intValue(value: unknown, fallback: number): number {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeBlueSkyAccountId(accountId?: unknown): string {
	if (typeof accountId !== "string") return DEFAULT_BLUESKY_ACCOUNT_ID;
	const trimmed = accountId.trim();
	return trimmed || DEFAULT_BLUESKY_ACCOUNT_ID;
}

export function listBlueSkyAccountIds(runtime: IAgentRuntime): string[] {
	const ids = new Set<string>();
	const config = characterConfig(runtime);
	if (
		stringSetting(runtime, "BLUESKY_HANDLE") ||
		(config.handle && config.password)
	) {
		ids.add(DEFAULT_BLUESKY_ACCOUNT_ID);
	}
	for (const id of Object.keys(allAccountConfigs(runtime))) {
		ids.add(normalizeBlueSkyAccountId(id));
	}
	return Array.from(ids.size ? ids : new Set([DEFAULT_BLUESKY_ACCOUNT_ID])).sort(
		(a, b) => a.localeCompare(b),
	);
}

export function resolveDefaultBlueSkyAccountId(runtime: IAgentRuntime): string {
	const requested =
		stringSetting(runtime, "BLUESKY_DEFAULT_ACCOUNT_ID") ??
		stringSetting(runtime, "BLUESKY_ACCOUNT_ID");
	if (requested) return normalizeBlueSkyAccountId(requested);
	const ids = listBlueSkyAccountIds(runtime);
	return ids.includes(DEFAULT_BLUESKY_ACCOUNT_ID)
		? DEFAULT_BLUESKY_ACCOUNT_ID
		: ids[0];
}

export function readBlueSkyAccountId(...sources: unknown[]): string | undefined {
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
		if (typeof value === "string" && value.trim()) return normalizeBlueSkyAccountId(value);
	}
	return undefined;
}

export function hasBlueSkyEnabled(
	runtime: IAgentRuntime,
	accountId?: string | null,
): boolean {
	const normalizedAccountId = normalizeBlueSkyAccountId(
		accountId ?? resolveDefaultBlueSkyAccountId(runtime),
	);
	const base = characterConfig(runtime);
	const account = accountConfig(runtime, normalizedAccountId);
	const allowEnv = normalizedAccountId === DEFAULT_BLUESKY_ACCOUNT_ID;
	const enabled =
		readRawField(account, ["enabled", "BLUESKY_ENABLED"]) ??
		readRawField(base, ["enabled", "BLUESKY_ENABLED"]) ??
		(allowEnv ? runtime.getSetting("BLUESKY_ENABLED") : undefined);
	if (enabled) return String(enabled).toLowerCase() === "true";
	return Boolean(
		(readRawField(account, ["handle", "BLUESKY_HANDLE"]) ??
			readRawField(base, ["handle", "BLUESKY_HANDLE"]) ??
			(allowEnv ? stringSetting(runtime, "BLUESKY_HANDLE") : undefined)) &&
			(readRawField(account, ["password", "BLUESKY_PASSWORD"]) ??
				readRawField(base, ["password", "BLUESKY_PASSWORD"]) ??
				(allowEnv ? stringSetting(runtime, "BLUESKY_PASSWORD") : undefined)),
	);
}

export function validateBlueSkyConfig(
	runtime: IAgentRuntime,
	accountId?: string | null,
): ResolvedBlueSkyConfig {
	const normalizedAccountId = normalizeBlueSkyAccountId(
		accountId ?? resolveDefaultBlueSkyAccountId(runtime),
	);
	const base = characterConfig(runtime);
	const account = accountConfig(runtime, normalizedAccountId);
	const allowEnv = normalizedAccountId === DEFAULT_BLUESKY_ACCOUNT_ID;
	const result = BlueSkyConfigSchema.safeParse({
		handle:
			readRawField(account, ["handle", "BLUESKY_HANDLE"]) ??
			readRawField(base, ["handle", "BLUESKY_HANDLE"]) ??
			(allowEnv ? stringSetting(runtime, "BLUESKY_HANDLE") : undefined) ??
			"",
		password:
			readRawField(account, ["password", "BLUESKY_PASSWORD"]) ??
			readRawField(base, ["password", "BLUESKY_PASSWORD"]) ??
			(allowEnv ? stringSetting(runtime, "BLUESKY_PASSWORD") : undefined) ??
			"",
		service:
			readRawField(account, ["service", "BLUESKY_SERVICE"]) ??
			readRawField(base, ["service", "BLUESKY_SERVICE"]) ??
			(allowEnv ? stringSetting(runtime, "BLUESKY_SERVICE") : undefined) ??
			BLUESKY_SERVICE_URL,
		dryRun: boolValue(
			readRawField(account, ["dryRun", "BLUESKY_DRY_RUN"]) ??
				readRawField(base, ["dryRun", "BLUESKY_DRY_RUN"]) ??
				(allowEnv ? runtime.getSetting("BLUESKY_DRY_RUN") : undefined),
		),
		pollInterval:
			intValue(
				readRawField(account, ["pollInterval", "BLUESKY_POLL_INTERVAL"]) ??
					readRawField(base, ["pollInterval", "BLUESKY_POLL_INTERVAL"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_POLL_INTERVAL") : undefined),
				BLUESKY_POLL_INTERVAL,
			),
		enablePost:
			String(
				readRawField(account, ["enablePost", "BLUESKY_ENABLE_POSTING"]) ??
					readRawField(base, ["enablePost", "BLUESKY_ENABLE_POSTING"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_ENABLE_POSTING") : undefined) ??
					"true",
			).toLowerCase() !== "false",
		postIntervalMin:
			intValue(
				readRawField(account, ["postIntervalMin", "BLUESKY_POST_INTERVAL_MIN"]) ??
					readRawField(base, ["postIntervalMin", "BLUESKY_POST_INTERVAL_MIN"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") : undefined),
				BLUESKY_POST_INTERVAL_MIN,
			),
		postIntervalMax:
			intValue(
				readRawField(account, ["postIntervalMax", "BLUESKY_POST_INTERVAL_MAX"]) ??
					readRawField(base, ["postIntervalMax", "BLUESKY_POST_INTERVAL_MAX"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") : undefined),
				BLUESKY_POST_INTERVAL_MAX,
			),
		enableActionProcessing:
			String(
				readRawField(account, ["enableActionProcessing", "BLUESKY_ENABLE_ACTION_PROCESSING"]) ??
					readRawField(base, ["enableActionProcessing", "BLUESKY_ENABLE_ACTION_PROCESSING"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_ENABLE_ACTION_PROCESSING") : undefined) ??
					"true",
			).toLowerCase() !== "false",
		actionInterval:
			intValue(
				readRawField(account, ["actionInterval", "BLUESKY_ACTION_INTERVAL"]) ??
					readRawField(base, ["actionInterval", "BLUESKY_ACTION_INTERVAL"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_ACTION_INTERVAL") : undefined),
				BLUESKY_ACTION_INTERVAL,
			),
		postImmediately: boolValue(
			readRawField(account, ["postImmediately", "BLUESKY_POST_IMMEDIATELY"]) ??
				readRawField(base, ["postImmediately", "BLUESKY_POST_IMMEDIATELY"]) ??
				(allowEnv ? runtime.getSetting("BLUESKY_POST_IMMEDIATELY") : undefined),
		),
		maxActionsProcessing:
			intValue(
				readRawField(account, ["maxActionsProcessing", "BLUESKY_MAX_ACTIONS_PROCESSING"]) ??
					readRawField(base, ["maxActionsProcessing", "BLUESKY_MAX_ACTIONS_PROCESSING"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") : undefined),
				BLUESKY_MAX_ACTIONS,
			),
		enableDMs:
			String(
				readRawField(account, ["enableDMs", "BLUESKY_ENABLE_DMS"]) ??
					readRawField(base, ["enableDMs", "BLUESKY_ENABLE_DMS"]) ??
					(allowEnv ? runtime.getSetting("BLUESKY_ENABLE_DMS") : undefined) ??
					"true",
			).toLowerCase() !== "false",
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

	return { ...result.data, accountId: normalizedAccountId };
}

export function getPollInterval(runtime: IAgentRuntime): number {
	const seconds =
		parseInt(String(runtime.getSetting("BLUESKY_POLL_INTERVAL") ?? ""), 10) ||
		BLUESKY_POLL_INTERVAL;
	return seconds * 1000;
}

export function getActionInterval(runtime: IAgentRuntime): number {
	const seconds =
		parseInt(String(runtime.getSetting("BLUESKY_ACTION_INTERVAL") ?? ""), 10) ||
		BLUESKY_ACTION_INTERVAL;
	return seconds * 1000;
}

export function getMaxActionsProcessing(runtime: IAgentRuntime): number {
	return (
		parseInt(
			String(runtime.getSetting("BLUESKY_MAX_ACTIONS_PROCESSING") ?? ""),
			10,
		) || BLUESKY_MAX_ACTIONS
	);
}

export function isPostingEnabled(runtime: IAgentRuntime): boolean {
	return runtime.getSetting("BLUESKY_ENABLE_POSTING") !== "false";
}

export function shouldPostImmediately(runtime: IAgentRuntime): boolean {
	return runtime.getSetting("BLUESKY_POST_IMMEDIATELY") === "true";
}

export function getPostIntervalRange(runtime: IAgentRuntime): {
	min: number;
	max: number;
} {
	const min =
		parseInt(
			String(runtime.getSetting("BLUESKY_POST_INTERVAL_MIN") ?? ""),
			10,
		) || BLUESKY_POST_INTERVAL_MIN;
	const max =
		parseInt(
			String(runtime.getSetting("BLUESKY_POST_INTERVAL_MAX") ?? ""),
			10,
		) || BLUESKY_POST_INTERVAL_MAX;
	return { min: min * 1000, max: max * 1000 };
}
