/**
 * Dashboard-only markers and widget blocks.
 *
 * Part of the reply vocabulary is rendered exclusively by the dashboard chat
 * surface and means nothing anywhere else: the single-line `[CONFIG:<pluginId>]`
 * plugin-card and `[BACKGROUND]` wallpaper-picker markers, and the JSON-bodied
 * `[CHECKLIST]`/`[WORKFLOW]` widget blocks (see packages/ui
 * message-parser-helpers and the per-widget parsers it collects). None of these
 * are part of the interaction-block grammar, so `parseInteractionBlocks`
 * deliberately leaves them in `cleanedText` — which means every non-dashboard
 * connector that renders from cleanedText leaks them verbatim into chat
 * (live: `[CONFIG:google_calendars]` raw over api/chat replies, Finding B at
 * HQ #18309; a raw `[CHECKLIST]{json}[/CHECKLIST]` block in an api reply,
 * tj-578adf524ebb7a).
 *
 * Bare markers are stripped; widget blocks degrade to a plain-text projection
 * of their content (a checklist keeps its items, a workflow keeps its steps) so
 * button-less transports lose the widget, not the answer. A malformed widget
 * body keeps its body text with the bracket markers removed — the same
 * plain-text fallback the dashboard applies, minus the wire syntax.
 *
 * The canonical interaction parser applies this only to its connector-facing
 * `cleanedText`; it never mutates the original content consumed by the
 * dashboard. Every pattern below mirrors its dashboard counterpart exactly so
 * the two projections agree about what constitutes a marker.
 */

/** Matches `[CONFIG:<pluginId>]` — keep in lockstep with the dashboard's CONFIG_RE. */
const DASHBOARD_CONFIG_MARKER_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;

/** Matches the bare `[BACKGROUND]` picker marker — lockstep with BACKGROUND_RE. */
const DASHBOARD_BACKGROUND_MARKER_RE = /\[BACKGROUND\]/g;

/** Marker glyphs for checklist item statuses (`- [x]` renders as a task list on markdown surfaces). */
const CHECKLIST_STATUS_GLYPHS: Record<string, string> = {
	completed: "[x]",
	in_progress: "[~]",
	pending: "[ ]",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Project a `[CHECKLIST]` JSON body onto plain task-list lines. Returns null
 * for a body the dashboard would also treat as malformed, so the caller can
 * apply the shared strip-markers-keep-body fallback.
 */
function checklistBodyToPlainText(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// error-policy:J3 untrusted model output — null signals malformed so the
		// block degrades to its body text instead of a fake-valid empty list.
		return null;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.items)) return null;
	const lines: string[] = [];
	for (const raw of parsed.items) {
		if (!isRecord(raw) || typeof raw.content !== "string") continue;
		const content = raw.content.trim();
		if (!content) continue;
		const glyph =
			typeof raw.status === "string"
				? (CHECKLIST_STATUS_GLYPHS[raw.status] ??
					CHECKLIST_STATUS_GLYPHS.pending)
				: CHECKLIST_STATUS_GLYPHS.pending;
		lines.push(`- ${glyph} ${content}`);
	}
	if (lines.length === 0) return null;
	const title =
		typeof parsed.title === "string" && parsed.title.trim().length > 0
			? `${parsed.title.trim()}:\n`
			: "";
	return `${title}${lines.join("\n")}`;
}

/**
 * Project a `[WORKFLOW]` JSON body onto numbered step lines with their status.
 * Null signals malformed, same contract as {@link checklistBodyToPlainText}.
 */
function workflowBodyToPlainText(body: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// error-policy:J3 untrusted model output — null signals malformed so the
		// block degrades to its body text instead of a fake-valid empty pipeline.
		return null;
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return null;
	const lines: string[] = [];
	for (const raw of parsed.steps) {
		if (!isRecord(raw) || typeof raw.label !== "string") continue;
		const label = raw.label.trim();
		if (!label) continue;
		const status =
			typeof raw.status === "string" && raw.status.trim().length > 0
				? raw.status.trim()
				: "pending";
		lines.push(`${lines.length + 1}. ${label} — ${status}`);
	}
	if (lines.length === 0) return null;
	const title =
		typeof parsed.title === "string" && parsed.title.trim().length > 0
			? `${parsed.title.trim()}:\n`
			: "";
	return `${title}${lines.join("\n")}`;
}

function degradeWidgetBlocks(text: string): string {
	return replaceDashboardBlocks(
		replaceDashboardBlocks(
			text,
			"CHECKLIST",
			(body) => checklistBodyToPlainText(body) ?? body.trim(),
		),
		"WORKFLOW",
		(body) => workflowBodyToPlainText(body) ?? body.trim(),
	);
}

function replaceDashboardBlocks(
	text: string,
	kind: "CHECKLIST" | "WORKFLOW",
	render: (body: string) => string,
): string {
	const opening = `[${kind}]\n`;
	const closing = `\n[/${kind}]`;
	const chunks: string[] = [];
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf(opening, cursor);
		if (start < 0) break;
		const end = text.indexOf(closing, start + opening.length);
		if (end < 0) break;
		chunks.push(
			text.slice(cursor, start),
			render(text.slice(start + opening.length, end)),
		);
		cursor = end + closing.length;
	}
	if (chunks.length === 0) return text;
	chunks.push(text.slice(cursor));
	return chunks.join("");
}

/**
 * Remove dashboard-only markers from connector-bound prose and degrade
 * dashboard widget blocks to plain text. Collapses the whitespace a removed
 * marker leaves behind so chat output has no orphan blank lines.
 */
export function stripDashboardOnlyMarkers(text: string): string {
	if (
		!text.includes("[CONFIG:") &&
		!text.includes("[BACKGROUND]") &&
		!text.includes("[CHECKLIST]") &&
		!text.includes("[WORKFLOW]")
	) {
		return text;
	}
	return degradeWidgetBlocks(text)
		.replace(DASHBOARD_CONFIG_MARKER_RE, "")
		.replace(DASHBOARD_BACKGROUND_MARKER_RE, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
