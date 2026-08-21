/**
 * Surfaces recent runtime failures reported via `runtime.reportError` into the
 * agent's prompt (#12263 / parent #12182).
 *
 * Failures outside the action path (providers, services, background jobs, event
 * handlers) do not otherwise reach the model. This provider reads the runtime's
 * in-memory reported-error ring, dedupes by `code`, ages out stale entries, caps
 * the list, and appends a short instruction so the agent can attempt a fix or
 * tell the owner. It renders nothing (and costs no prompt tokens) when there are
 * no recent errors — no prompt bloat on the healthy path.
 *
 * Error text is third-party-controlled: a plugin can report an error whose
 * message or context embeds a credential (a `?key=` URL, an Authorization
 * header). Everything rendered into the prompt therefore goes through
 * `runtime.redactSecrets` first, so reported errors can't ship secrets to
 * external model providers.
 */

import type { ReportedError } from "../errors";
import { logger } from "../logger";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../types";
import {
	deepToWellFormedUnicode,
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

/** Newest N distinct-by-code errors surfaced into the prompt. */
const MAX_RECENT_ERRORS = 5;
/** Entries older than this are ignored (stale failures shouldn't linger). */
const ERROR_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Internal scheduler/plumbing failure codes that must NEVER be narrated into the
 * owner's chat (#SHADOW-ACCOUNT-DEBUG). These are self-healing or
 * operator-facing, not user-actionable: surfacing them made the agent post
 * near-identical "a scheduled task failed … TASK_WORKER_MISSING" messages 9×
 * into Shadow's chat. The failures are still logged and still flow to the
 * ERROR_REPORTED escalation path (which has its own owner-facing threshold);
 * they just don't get turned into assistant messages every turn. Matching is
 * done on the error `code`, so app-level/actionable failures are unaffected.
 */
export const QUIET_ERROR_CODES: ReadonlySet<string> = new Set([
	"TASK_TICK_FAILED",
	"TASK_WORKER_MISSING",
	"TASK_QUERY_FAILED",
	"TASK_ORPHAN_QUARANTINE_FAILED",
]);
/** Cap serialized context length so a large payload can't blow up the prompt. */
export const MAX_CONTEXT_CHARS = 400;

const EMPTY_RESULT: ProviderResult = {
	data: { recentErrors: [] },
	values: { recentErrors: "" },
	text: "",
};

export function serializeContext(
	context: Record<string, unknown> | undefined,
): string | undefined {
	if (!context || Object.keys(context).length === 0) return undefined;
	let text: string;
	try {
		const safeContext = deepToWellFormedUnicode(context);
		text = JSON.stringify(safeContext);
	} catch {
		// error-policy:J3 untrusted-input sanitizing — context may hold a
		// circular/non-serializable value; drop it rather than fabricate one.
		return undefined;
	}
	const wellFormed = toWellFormedUnicode(text);
	if (wellFormed.length <= MAX_CONTEXT_CHARS) {
		return wellFormed;
	}
	const budget = Math.max(0, MAX_CONTEXT_CHARS - 1);
	return `${truncateWellFormed(wellFormed, budget).trimEnd()}…`;
}

/**
 * Reduce the raw ring to the newest entry per `code` within the age window,
 * ordered newest-first, capped at {@link MAX_RECENT_ERRORS}.
 */
function selectRecentErrors(
	entries: ReportedError[],
	now: number,
): ReportedError[] {
	const newestByCode = new Map<string, ReportedError>();
	for (const entry of entries) {
		if (now - entry.at > ERROR_MAX_AGE_MS) continue;
		if (entry.context?.diagnosticOnly === true) continue;
		// Internal scheduler plumbing is self-healing / operator-facing, never
		// narrated into chat (#SHADOW-ACCOUNT-DEBUG). Still logged + escalated.
		if (QUIET_ERROR_CODES.has(entry.code)) continue;
		const existing = newestByCode.get(entry.code);
		if (!existing || entry.at >= existing.at) {
			newestByCode.set(entry.code, entry);
		}
	}
	return [...newestByCode.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, MAX_RECENT_ERRORS);
}

function renderText(
	selected: ReportedError[],
	redact: (text: string) => string,
): string {
	const lines = selected.map((entry) => {
		const ctx = serializeContext(entry.context);
		const suffix = ctx ? ` — ${redact(ctx)}` : "";
		return `- [${entry.scope}] ${entry.code}: ${redact(entry.message)}${suffix}`;
	});
	// The framing must make the block self-quarantining: rendered into a group
	// turn, an unframed error list reads like conversation topic material — a
	// live "available_apps provider timeout" got answered as if it were the
	// user's question (tj-f8249b30e986d6). State explicitly that these are
	// internal diagnostics and that user messages are never about them unless
	// the user explicitly asks about errors.
	return `## Recent runtime errors (internal diagnostics)

The following failures were reported outside the normal action flow. They are internal diagnostics for your own self-awareness — not conversation content. Never assume a user's message refers to them unless the user explicitly asks about errors.

${lines.join("\n")}

If a failure looks actionable, attempt to resolve it (re-run the operation, reconfigure the failing feature, or disable it). If it looks systemic or you cannot resolve it, tell the owner.`;
}

/**
 * RECENT_ERRORS — injects deduped, aged-out recent runtime failures into the
 * agent context so the agent can react to problems outside the action path.
 */
export const recentErrorsProvider: Provider = {
	name: "RECENT_ERRORS",
	description:
		"Recent runtime failures reported outside the action path (deduped by code)",
	dynamic: true,
	// Failures matter most on the narrow planner/tool turns this provider would
	// otherwise miss (undeclared → ["general"] routing). Always-on is free on the
	// happy path: it renders nothing when there are no recent errors (#13203).
	alwaysInResponseState: true,

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const entries = runtime.getRecentReportedErrors();
		if (entries.length === 0) return EMPTY_RESULT;

		const selected = selectRecentErrors(entries, Date.now());
		if (selected.length === 0) return EMPTY_RESULT;

		const text = renderText(selected, (value) => runtime.redactSecrets(value));
		logger.debug(
			{ src: "agent", count: selected.length },
			"[RecentErrorsProvider] Surfacing recent reported errors",
		);
		return {
			data: { recentErrors: selected },
			values: { recentErrors: text },
			text,
		};
	},
};
