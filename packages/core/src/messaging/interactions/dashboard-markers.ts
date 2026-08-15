/**
 * Dashboard-only inline markers.
 *
 * Some single-line markers in agent reply text are rendered exclusively by the
 * dashboard chat surface and mean nothing anywhere else — `[CONFIG:<pluginId>]`
 * becomes a plugin setup card (see packages/ui message-parser-helpers). They
 * are NOT part of the interaction-block grammar, so `parseInteractionBlocks`
 * deliberately leaves them in `cleanedText` — which means every non-dashboard
 * connector that renders from cleanedText leaks them verbatim into chat
 * (live: `[CONFIG:google_calendars]` delivered raw over api/chat replies,
 * Finding B at HQ #18309).
 *
 * Connectors without a dashboard renderer strip them with
 * {@link stripDashboardOnlyMarkers} after parsing interaction blocks. The
 * pattern mirrors the dashboard's own CONFIG_RE exactly so the two surfaces
 * can never disagree about what constitutes a marker.
 */

/** Matches `[CONFIG:<pluginId>]` — keep in lockstep with the dashboard's CONFIG_RE. */
const DASHBOARD_CONFIG_MARKER_RE = /\[CONFIG:([@\w][\w@./:-]*)\]/g;

/**
 * Remove dashboard-only markers from connector-bound prose. Collapses the
 * whitespace a removed marker leaves behind so chat output has no orphan
 * blank lines.
 */
export function stripDashboardOnlyMarkers(text: string): string {
	if (!text || !text.includes("[CONFIG:")) return text;
	return text
		.replace(DASHBOARD_CONFIG_MARKER_RE, "")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
