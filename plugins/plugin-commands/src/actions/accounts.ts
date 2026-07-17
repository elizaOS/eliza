/**
 * `/accounts` — operator surface over the multi-account credential pool
 * (`packages/agent/src/api/accounts-routes.ts`). The handler never owns
 * account state: it parses the token shape, then drives the same loopback
 * routes the settings UI uses, so route validation errors surface verbatim.
 *
 * Token grammar (bare `/accounts` renders the per-provider report):
 *   /accounts
 *   /accounts use|enable|disable <provider> <account>
 *   /accounts strategy <provider> <priority|round-robin|least-used|quota-aware|reset-soonest|drain-soonest-reset>
 *   /accounts refresh <provider> [account]
 *
 * `<provider>` accepts the wire ids plus the short aliases claude/codex/
 * cerebras. `<account>` matches by exact id, id prefix (≥6 chars), exact
 * label, or exact email — case-insensitive; an ambiguous or empty match
 * replies with the candidate list and never guesses.
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import type { CommandResult, ParsedCommand } from "../types";

/** Provider-level selection strategies accepted by PATCH …/strategy. */
export const ACCOUNT_STRATEGIES = [
	"priority",
	"round-robin",
	"least-used",
	"quota-aware",
	"reset-soonest",
	"drain-soonest-reset",
] as const;
type AccountStrategy = (typeof ACCOUNT_STRATEGIES)[number];

/** Wire provider ids served by GET /api/accounts. */
export const ACCOUNT_PROVIDER_IDS = [
	"anthropic-subscription",
	"openai-codex",
	"gemini-cli",
	"zai-coding",
	"kimi-coding",
	"deepseek-coding",
	"anthropic-api",
	"openai-api",
	"deepseek-api",
	"zai-api",
	"moonshot-api",
	"cerebras-api",
] as const;
type AccountProviderId = (typeof ACCOUNT_PROVIDER_IDS)[number];

/** Short operator aliases for the most-used providers. */
export const ACCOUNT_PROVIDER_ALIASES: Record<string, AccountProviderId> = {
	claude: "anthropic-subscription",
	codex: "openai-codex",
	cerebras: "cerebras-api",
};

export type AccountsCommand =
	| { kind: "report" }
	| {
			kind: "use" | "enable" | "disable";
			provider: AccountProviderId;
			account: string;
	  }
	| { kind: "strategy"; provider: AccountProviderId; strategy: AccountStrategy }
	| { kind: "refresh"; provider: AccountProviderId; account?: string }
	| { kind: "usage"; error: string };

const ACTION_USAGE =
	"Usage: /accounts [use|enable|disable <provider> <account>] [strategy <provider> <strategy>] [refresh <provider> [account]]";

function reply(text: string): CommandResult {
	return { handled: true, reply: text, shouldContinue: false };
}

function providerUsage(token: string): string {
	return `Unknown provider "${token}". Use ${Object.keys(ACCOUNT_PROVIDER_ALIASES).join(", ")} or a wire id (${ACCOUNT_PROVIDER_IDS.join(", ")}).`;
}

function resolveProviderToken(token: string): AccountProviderId | null {
	const lower = token.toLowerCase();
	const alias = ACCOUNT_PROVIDER_ALIASES[lower];
	if (alias) return alias;
	return (ACCOUNT_PROVIDER_IDS as readonly string[]).includes(lower)
		? (lower as AccountProviderId)
		: null;
}

function isStrategy(token: string): token is AccountStrategy {
	return (ACCOUNT_STRATEGIES as readonly string[]).includes(token);
}

/**
 * Parse a `/accounts` argument list. Bare args render the report; a malformed
 * subcommand becomes a usage error (never a guessed action).
 */
export function parseAccountsArgs(parsed: ParsedCommand): AccountsCommand {
	const tokens = (parsed.rawArgs?.trim() || parsed.args.join(" ").trim())
		.split(/\s+/)
		.filter(Boolean);
	if (tokens.length === 0) return { kind: "report" };

	const action = (tokens[0] as string).toLowerCase();

	if (action === "use" || action === "enable" || action === "disable") {
		if (tokens.length !== 3) {
			return {
				kind: "usage",
				error: `Usage: /accounts ${action} <provider> <account>`,
			};
		}
		const provider = resolveProviderToken(tokens[1] as string);
		if (!provider) {
			return { kind: "usage", error: providerUsage(tokens[1] as string) };
		}
		return { kind: action, provider, account: tokens[2] as string };
	}

	if (action === "strategy") {
		if (tokens.length !== 3) {
			return {
				kind: "usage",
				error: `Usage: /accounts strategy <provider> <${ACCOUNT_STRATEGIES.join("|")}>`,
			};
		}
		const provider = resolveProviderToken(tokens[1] as string);
		if (!provider) {
			return { kind: "usage", error: providerUsage(tokens[1] as string) };
		}
		const strategy = (tokens[2] as string).toLowerCase();
		if (!isStrategy(strategy)) {
			return {
				kind: "usage",
				error: `Unknown strategy "${tokens[2]}". Supported: ${ACCOUNT_STRATEGIES.join(", ")}.`,
			};
		}
		return { kind: "strategy", provider, strategy };
	}

	if (action === "refresh") {
		if (tokens.length < 2 || tokens.length > 3) {
			return {
				kind: "usage",
				error: "Usage: /accounts refresh <provider> [account]",
			};
		}
		const provider = resolveProviderToken(tokens[1] as string);
		if (!provider) {
			return { kind: "usage", error: providerUsage(tokens[1] as string) };
		}
		return {
			kind: "refresh",
			provider,
			...(tokens[2] ? { account: tokens[2] } : {}),
		};
	}

	return { kind: "usage", error: ACTION_USAGE };
}

// ── Wire shapes (GET /api/accounts) ─────────────────────────────────────────

interface AccountUsageWire {
	sessionPct?: number;
	weeklyPct?: number;
	resetsAt?: number;
	refreshedAt?: number;
}

interface AccountWire {
	id: string;
	label: string;
	email?: string;
	enabled: boolean;
	priority: number;
	health: string;
	hasCredential?: boolean;
	usage?: AccountUsageWire;
	subscriptionEndsAt?: number;
}

interface ProviderWire {
	providerId: string;
	strategy: string;
	accounts: AccountWire[];
}

type RouteOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

function routeErrorMessage(
	body: Record<string, unknown> | null,
	status: number,
): string {
	return typeof body?.error === "string"
		? body.error
		: `route returned ${status}`;
}

async function callAccountsRoute(
	path: string,
	init?: RequestInit,
): Promise<RouteOutcome<Record<string, unknown> | null>> {
	const port = resolveServerOnlyPort(process.env);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${port}${path}`, {
			...init,
			signal: AbortSignal.timeout(30_000),
		});
	} catch (err) {
		return {
			ok: false,
			message: err instanceof Error ? err.message : String(err),
		};
	}
	// error-policy:J3 non-JSON/empty response body -> null; response.ok decides
	// success, so an unparseable body is a handled shape.
	const body = (await response.json().catch(() => null)) as Record<
		string,
		unknown
	> | null;
	if (!response.ok) {
		return { ok: false, message: routeErrorMessage(body, response.status) };
	}
	return { ok: true, value: body };
}

async function listProvidersViaRoute(): Promise<RouteOutcome<ProviderWire[]>> {
	const outcome = await callAccountsRoute("/api/accounts");
	if (!outcome.ok) return outcome;
	const providers = outcome.value?.providers;
	if (!Array.isArray(providers)) {
		return { ok: false, message: "route returned no providers array" };
	}
	return { ok: true, value: providers as ProviderWire[] };
}

async function patchAccountViaRoute(
	providerId: AccountProviderId,
	accountId: string,
	body: { enabled: boolean },
): Promise<RouteOutcome<Record<string, unknown> | null>> {
	return callAccountsRoute(`/api/accounts/${providerId}/${accountId}`, {
		method: "PATCH",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatRelative(timestampMs: number, nowMs: number): string {
	const deltaMs = timestampMs - nowMs;
	const absMs = Math.abs(deltaMs);
	const minutes = Math.round(absMs / 60_000);
	const spell =
		minutes < 60
			? `${Math.max(minutes, 1)}m`
			: minutes < 24 * 60
				? `${Math.floor(minutes / 60)}h ${minutes % 60}m`
				: `${Math.floor(minutes / (24 * 60))}d ${Math.floor((minutes % (24 * 60)) / 60)}h`;
	return deltaMs >= 0 ? `in ${spell}` : `${spell} ago`;
}

function formatAccountLine(account: AccountWire, nowMs: number): string {
	const who = account.email
		? `${account.label} (${account.email})`
		: account.label;
	const parts = [
		account.enabled ? "enabled" : "disabled",
		`prio ${account.priority}`,
	];
	const usage = account.usage;
	if (
		typeof usage?.sessionPct === "number" ||
		typeof usage?.weeklyPct === "number"
	) {
		const pct = (value: number | undefined) =>
			typeof value === "number" ? `${Math.round(value)}%` : "?";
		parts.push(
			`session ${pct(usage?.sessionPct)} / weekly ${pct(usage?.weeklyPct)}`,
		);
	}
	if (typeof usage?.resetsAt === "number") {
		parts.push(`resets ${formatRelative(usage.resetsAt, nowMs)}`);
	}
	parts.push(account.health);
	return `  ${who} — ${parts.join(", ")}`;
}

function formatProviderBlock(provider: ProviderWire, nowMs: number): string[] {
	const lines = [`**${provider.providerId}** (strategy: ${provider.strategy})`];
	for (const account of provider.accounts) {
		lines.push(formatAccountLine(account, nowMs));
	}
	return lines;
}

// ── Account matching ────────────────────────────────────────────────────────

const ID_PREFIX_MIN_CHARS = 6;

type AccountMatch =
	| { kind: "match"; account: AccountWire }
	| { kind: "ambiguous"; candidates: AccountWire[] }
	| { kind: "none"; candidates: AccountWire[] };

/**
 * Match one account by exact id, id prefix (≥6 chars), exact label, or exact
 * email — case-insensitive. Anything but exactly one hit returns the candidate
 * set so the caller can refuse instead of guessing.
 */
export function matchAccount(
	accounts: AccountWire[],
	token: string,
): AccountMatch {
	const needle = token.toLowerCase();
	const exactId = accounts.find((a) => a.id.toLowerCase() === needle);
	if (exactId) return { kind: "match", account: exactId };

	const hits = new Map<string, AccountWire>();
	for (const account of accounts) {
		const matched =
			account.label.toLowerCase() === needle ||
			account.email?.toLowerCase() === needle ||
			(needle.length >= ID_PREFIX_MIN_CHARS &&
				account.id.toLowerCase().startsWith(needle));
		if (matched) hits.set(account.id, account);
	}
	const candidates = [...hits.values()];
	if (candidates.length === 1) {
		return { kind: "match", account: candidates[0] as AccountWire };
	}
	if (candidates.length > 1) return { kind: "ambiguous", candidates };
	return { kind: "none", candidates: accounts };
}

function describeCandidates(accounts: AccountWire[]): string {
	return accounts
		.map((a) => {
			const who = a.email ? `${a.label} (${a.email})` : a.label;
			return `  ${who} — id ${a.id}`;
		})
		.join("\n");
}

function matchFailureReply(
	match: Extract<AccountMatch, { kind: "ambiguous" | "none" }>,
	provider: AccountProviderId,
	token: string,
): CommandResult {
	const heading =
		match.kind === "ambiguous"
			? `"${token}" matches more than one ${provider} account — be more specific:`
			: `No ${provider} account matches "${token}". Linked accounts:`;
	return reply(`${heading}\n${describeCandidates(match.candidates)}`);
}

// ── Subcommand runners ──────────────────────────────────────────────────────

function findProvider(
	providers: ProviderWire[],
	providerId: AccountProviderId,
): ProviderWire | undefined {
	return providers.find(
		(p) => p.providerId === providerId && p.accounts.length > 0,
	);
}

function couldNot(what: string, message: string): CommandResult {
	return reply(`Couldn't ${what}: ${message}`);
}

/** Bare `/accounts` — compact report of every provider that has accounts. */
export async function runAccountsReportViaRoute(): Promise<CommandResult> {
	const outcome = await listProvidersViaRoute();
	if (!outcome.ok) return couldNot("read the accounts", outcome.message);
	const withAccounts = outcome.value.filter((p) => p.accounts.length > 0);
	if (withAccounts.length === 0) return reply("No linked accounts.");
	const nowMs = Date.now();
	const lines = ["Linked accounts:"];
	for (const provider of withAccounts) {
		lines.push(...formatProviderBlock(provider, nowMs));
	}
	return reply(lines.join("\n"));
}

/**
 * `use` makes the target the only enabled account of its provider: the pool's
 * selector only picks enabled accounts, so enabling the target and disabling
 * its enabled siblings makes it the deterministic next pick regardless of
 * strategy. `enable`/`disable` are the single-account PATCH.
 */
export async function runAccountsToggleViaRoute(
	kind: "use" | "enable" | "disable",
	provider: AccountProviderId,
	accountToken: string,
): Promise<CommandResult> {
	const outcome = await listProvidersViaRoute();
	if (!outcome.ok) return couldNot("read the accounts", outcome.message);
	const providerWire = findProvider(outcome.value, provider);
	if (!providerWire) return reply(`No linked accounts for ${provider}.`);

	const match = matchAccount(providerWire.accounts, accountToken);
	if (match.kind !== "match") {
		return matchFailureReply(match, provider, accountToken);
	}
	const target = match.account;

	if (kind !== "use") {
		const enabled = kind === "enable";
		const patched = await patchAccountViaRoute(provider, target.id, {
			enabled,
		});
		if (!patched.ok)
			return couldNot(`${kind} ${target.label}`, patched.message);
		return reply(
			`${enabled ? "Enabled" : "Disabled"} ${target.label} for ${provider}.`,
		);
	}

	const patched = await patchAccountViaRoute(provider, target.id, {
		enabled: true,
	});
	if (!patched.ok) return couldNot(`enable ${target.label}`, patched.message);
	const siblings = providerWire.accounts.filter(
		(a) => a.id !== target.id && a.enabled,
	);
	for (const sibling of siblings) {
		const disabled = await patchAccountViaRoute(provider, sibling.id, {
			enabled: false,
		});
		if (!disabled.ok) {
			return couldNot(`disable ${sibling.label}`, disabled.message);
		}
	}

	const refreshed = await listProvidersViaRoute();
	const lines = [`Now using ${target.label} for ${provider}.`];
	const resulting = refreshed.ok
		? findProvider(refreshed.value, provider)
		: undefined;
	if (resulting) {
		lines.push(
			...resulting.accounts.map(
				(a) => `  ${a.label} — ${a.enabled ? "enabled" : "disabled"}`,
			),
		);
	}
	return reply(lines.join("\n"));
}

export async function runAccountsStrategyViaRoute(
	provider: AccountProviderId,
	strategy: AccountStrategy,
): Promise<CommandResult> {
	const outcome = await callAccountsRoute(
		`/api/providers/${provider}/strategy`,
		{
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ strategy }),
		},
	);
	if (!outcome.ok) {
		return couldNot(`set the ${provider} strategy`, outcome.message);
	}
	return reply(`Account strategy for ${provider} set to ${strategy}.`);
}

/**
 * `refresh` POSTs refresh-usage for the matched account (or every account of
 * the provider when omitted), then re-reads the list so the reply shows the
 * fresh usage numbers. Per-account probe failures are reported, not hidden.
 */
export async function runAccountsRefreshViaRoute(
	provider: AccountProviderId,
	accountToken?: string,
): Promise<CommandResult> {
	const outcome = await listProvidersViaRoute();
	if (!outcome.ok) return couldNot("read the accounts", outcome.message);
	const providerWire = findProvider(outcome.value, provider);
	if (!providerWire) return reply(`No linked accounts for ${provider}.`);

	let targets = providerWire.accounts;
	if (accountToken !== undefined) {
		const match = matchAccount(providerWire.accounts, accountToken);
		if (match.kind !== "match") {
			return matchFailureReply(match, provider, accountToken);
		}
		targets = [match.account];
	}

	const failures: string[] = [];
	for (const account of targets) {
		const refreshed = await callAccountsRoute(
			`/api/accounts/${provider}/${account.id}/refresh-usage`,
			{ method: "POST" },
		);
		if (!refreshed.ok) {
			failures.push(`  ${account.label}: ${refreshed.message}`);
		}
	}

	const relisted = await listProvidersViaRoute();
	if (!relisted.ok) {
		return couldNot("re-read the accounts after refresh", relisted.message);
	}
	const fresh = findProvider(relisted.value, provider);
	const lines = [`Refreshed usage for ${provider}:`];
	if (fresh) lines.push(...formatProviderBlock(fresh, Date.now()).slice(1));
	if (failures.length > 0) {
		lines.push("Refresh failed for:", ...failures);
	}
	return reply(lines.join("\n"));
}
