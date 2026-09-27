/**
 * Persisted per-account disconnect policy for the Discord connector.
 *
 * Discord bot tokens live in character settings or `DISCORD_API_TOKEN`, which
 * this plugin does not own. Disconnecting an account therefore records a
 * disabled policy in the runtime cache, keyed by account id and a fingerprint
 * of the token that was disconnected. The service skips a disabled account at
 * startup and the connector-account provider stops listing it. Configuring a
 * different token under the same account id is a replacement and runs
 * normally.
 */
import { createHash } from "node:crypto";
import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import { normalizeAccountId, type ResolvedDiscordAccount } from "./accounts";

export const DISCORD_ACCOUNT_POLICY_CACHE_KEY =
	"discord/connector-account-policy/v1";

export interface DiscordDisabledAccountPolicy {
	/** Fingerprint of the token that was disconnected; empty when none was set. */
	tokenFingerprint: string;
	disabledAt: number;
}

export type DiscordAccountPolicy = Record<string, DiscordDisabledAccountPolicy>;

/** Non-reversible token fingerprint, so the policy never stores a secret. */
export function discordTokenFingerprint(token: string | undefined): string {
	if (!token) {
		return "";
	}
	return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

function isPolicyEntry(value: unknown): value is DiscordDisabledAccountPolicy {
	if (!value || typeof value !== "object") {
		return false;
	}
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.tokenFingerprint === "string" &&
		typeof entry.disabledAt === "number"
	);
}

export async function readDiscordAccountPolicy(
	runtime: Pick<IAgentRuntime, "getCache">,
): Promise<DiscordAccountPolicy> {
	const stored = await runtime.getCache<unknown>(
		DISCORD_ACCOUNT_POLICY_CACHE_KEY,
	);
	if (stored === undefined || stored === null) {
		return {};
	}
	if (typeof stored !== "object" || Array.isArray(stored)) {
		throw new ElizaError("Stored Discord account policy is malformed", {
			code: "DISCORD_ACCOUNT_POLICY_INVALID",
			severity: "fatal",
		});
	}
	const policy: DiscordAccountPolicy = {};
	for (const [accountId, entry] of Object.entries(stored)) {
		if (!isPolicyEntry(entry)) {
			throw new ElizaError("Stored Discord account policy is malformed", {
				code: "DISCORD_ACCOUNT_POLICY_INVALID",
				context: { accountId },
				severity: "fatal",
			});
		}
		policy[normalizeAccountId(accountId)] = entry;
	}
	return policy;
}

async function writeDiscordAccountPolicy(
	runtime: Pick<IAgentRuntime, "setCache">,
	policy: DiscordAccountPolicy,
	accountId: string,
): Promise<void> {
	const stored = await runtime.setCache(
		DISCORD_ACCOUNT_POLICY_CACHE_KEY,
		policy,
	);
	if (!stored) {
		throw new ElizaError("Failed to persist the Discord account policy", {
			code: "DISCORD_ACCOUNT_POLICY_WRITE_FAILED",
			context: { accountId },
			severity: "ephemeral",
		});
	}
}

/** Persist a disabled policy for the account's current token. */
export async function persistDiscordAccountDisabled(
	runtime: Pick<IAgentRuntime, "getCache" | "setCache">,
	account: Pick<ResolvedDiscordAccount, "accountId" | "token">,
	now = Date.now(),
): Promise<DiscordDisabledAccountPolicy> {
	const accountId = normalizeAccountId(account.accountId);
	const policy = await readDiscordAccountPolicy(runtime);
	const entry: DiscordDisabledAccountPolicy = {
		tokenFingerprint: discordTokenFingerprint(account.token),
		disabledAt: now,
	};
	policy[accountId] = entry;
	await writeDiscordAccountPolicy(runtime, policy, accountId);
	return entry;
}

/** True when the account's current token is the one that was disconnected. */
export function isDiscordAccountDisabledByPolicy(
	policy: DiscordAccountPolicy,
	account: Pick<ResolvedDiscordAccount, "accountId" | "token">,
): boolean {
	const entry = policy[normalizeAccountId(account.accountId)];
	return (
		entry !== undefined &&
		entry.tokenFingerprint === discordTokenFingerprint(account.token)
	);
}
