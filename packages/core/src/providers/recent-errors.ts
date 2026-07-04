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

/** Newest N distinct-by-code errors surfaced into the prompt. */
const MAX_RECENT_ERRORS = 5;
/** Entries older than this are ignored (stale failures shouldn't linger). */
const ERROR_MAX_AGE_MS = 30 * 60 * 1000;
/** Cap serialized context length so a large payload can't blow up the prompt. */
const MAX_CONTEXT_CHARS = 400;

const EMPTY_RESULT: ProviderResult = {
	data: { recentErrors: [] },
	values: { recentErrors: "" },
	text: "",
};

function serializeContext(
	context: Record<string, unknown> | undefined,
): string | undefined {
	if (!context || Object.keys(context).length === 0) return undefined;
	let text: string;
	try {
		text = JSON.stringify(context);
	} catch {
		// error-policy:J3 untrusted-input sanitizing — context may hold a
		// circular/non-serializable value; drop it rather than fabricate one.
		return undefined;
	}
	return text.length > MAX_CONTEXT_CHARS
		? `${text.slice(0, MAX_CONTEXT_CHARS)}…`
		: text;
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
		const existing = newestByCode.get(entry.code);
		if (!existing || entry.at >= existing.at) {
			newestByCode.set(entry.code, entry);
		}
	}
	return [...newestByCode.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, MAX_RECENT_ERRORS);
}

function renderText(selected: ReportedError[]): string {
	const lines = selected.map((entry) => {
		const ctx = serializeContext(entry.context);
		const suffix = ctx ? ` — ${ctx}` : "";
		return `- [${entry.scope}] ${entry.code}: ${entry.message}${suffix}`;
	});
	return `## Recent runtime errors

The following failures were reported outside the normal action flow:

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

		const text = renderText(selected);
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
