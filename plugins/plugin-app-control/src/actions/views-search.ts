/**
 * @module plugin-app-control/actions/views-search
 *
 * Hybrid search sub-mode: combines keyword scoring with embedding-based semantic
 * ranking via the /api/views/search endpoint.
 *
 * When the semantic index is populated the endpoint weights results 40% keyword
 * / 60% semantic, which handles typos, synonyms, and intent-based queries (e.g.
 * "track money" → wallet view). When no embedding model is configured the
 * endpoint falls back to keyword-only scoring transparently.
 *
 * Keyword scoring (used in the local fallback and by the server):
 *   100 — exact label match
 *    80 — label contains query
 *    60 — tag exact match
 *    40 — description contains query
 */

import type { ActionResult, HandlerCallback, ViewType } from "@elizaos/core";
import { getAppControlApiBase } from "../loopback-api.js";
import { describeTargetReference, targetReferenceLogView } from "../params.js";
import {
	parseViewSummary,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import { createViewsRequestHeaders } from "./views-request-auth.js";

export interface ScoredView {
	view: ViewSummary;
	score: number;
}

function toScoreValue(value: number): number {
	return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
}

function compareScoredView(a: ScoredView, b: ScoredView): number {
	const aScore = toScoreValue(a.score);
	const bScore = toScoreValue(b.score);
	if (bScore !== aScore) return bScore - aScore;
	return a.view.id.localeCompare(b.view.id);
}

export const __testCompareScoredView = compareScoredView;

export function scoreView(view: ViewSummary, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) return 0;

	const label = view.label.toLowerCase();
	if (label === q) return 100;
	if (label.includes(q)) return 80;

	// Tags are commonly hyphenated (screen-time, address-book, personal-assistant)
	// but users speak them spaced ("screen time"). Normalize hyphens to spaces on
	// both sides so the exact-tag tier still fires for the spoken form.
	const tags = view.tags ?? [];
	const qSpaced = q.replace(/-/g, " ");
	if (tags.some((t) => t.toLowerCase().replace(/-/g, " ") === qSpaced)) {
		return 60;
	}

	const description = (view.description ?? "").toLowerCase();
	if (description.includes(q)) return 40;

	return 0;
}

function formatSearchResults(
	results: readonly ScoredView[],
	query: string,
): string {
	// The query can be the whole-message fallback or an arbitrary planner blob;
	// only a name-shaped value renders quoted (else the neutral noun) so the
	// header never re-broadcasts a security envelope into chat.
	const shownQuery = describeTargetReference(query, "your search");
	if (results.length === 0) {
		return `No views found matching ${shownQuery}.`;
	}
	const lines: string[] = [`Views matching ${shownQuery} (${results.length}):`];
	for (const { view, score } of results) {
		const pathStr = view.path ? ` — ${view.path}` : "";
		const desc = view.description ? ` — ${view.description}` : "";
		lines.push(`  [${score}] ${view.label} (${view.id})${pathStr}${desc}`);
	}
	return lines.join("\n");
}

/**
 * Call the /api/views/search endpoint for hybrid keyword+semantic ranking.
 * Returns null when the endpoint is unreachable (caller falls back to keyword).
 */
async function fetchSemanticSearch(
	query: string,
	limit: number,
	viewType?: ViewType,
): Promise<ScoredView[] | null> {
	try {
		const url = new URL(`${getAppControlApiBase()}/api/views/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("limit", String(limit));
		if (viewType) url.searchParams.set("viewType", viewType);

		const resp = await fetch(url.toString(), {
			headers: createViewsRequestHeaders(),
			signal: AbortSignal.timeout(5_000),
		});
		if (!resp.ok) return null;

		const body = (await resp.json()) as { results?: unknown[] };
		if (!Array.isArray(body.results)) return null;

		const scored: ScoredView[] = [];
		for (const r of body.results) {
			if (r === null || typeof r !== "object" || Array.isArray(r)) continue;
			const entry = r as Record<string, unknown>;
			// Validate each entry through the same boundary parser the client uses
			// rather than blindly casting unvalidated server JSON into ViewSummary.
			// Malformed entries are skipped, not silently typed.
			try {
				scored.push({
					view: parseViewSummary(entry),
					score: typeof entry._score === "number" ? entry._score : 0,
				});
			} catch {
				// Skip entries missing required fields.
			}
		}
		return scored;
	} catch {
		return null;
	}
}

export interface RunViewsSearchInput {
	client: ViewsClient;
	query: string;
	viewType?: ViewType;
	callback?: HandlerCallback;
}

export async function runViewsSearch({
	client,
	query,
	viewType,
	callback,
}: RunViewsSearchInput): Promise<ActionResult> {
	if (!query.trim()) {
		const text =
			'Provide a search query to find views. Example: "search views wallet".';
		await callback?.({ text });
		return { success: false, text };
	}

	// Attempt hybrid semantic+keyword search via the server endpoint.
	const semanticResults = await fetchSemanticSearch(query, 5, viewType);
	if (semanticResults !== null) {
		const text = formatSearchResults(semanticResults, query);
		await callback?.({ text });
		return {
			success: true,
			text,
			values: {
				mode: "search",
				// Machine-facing echo of the query stays length-bounded: a weak
				// planner repeats tool values verbatim and blobs bloat context.
				query: targetReferenceLogView(query),
				viewType: viewType ?? "gui",
				resultCount: semanticResults.length,
			},
			data: { results: semanticResults },
		};
	}

	// Fallback: keyword-only scoring using the views client directly.
	const views = await client.listViews({ viewType });
	const scored: ScoredView[] = views
		.map((view) => ({ view, score: scoreView(view, query) }))
		.filter(({ score }) => score > 0)
		.sort(compareScoredView);

	const text = formatSearchResults(scored, query);
	await callback?.({ text });
	return {
		success: true,
		text,
		values: {
			mode: "search",
			// Machine-facing echo of the query stays length-bounded: a weak
			// planner repeats tool values verbatim and blobs bloat context.
			query: targetReferenceLogView(query),
			viewType: viewType ?? "gui",
			resultCount: scored.length,
		},
		data: { results: scored },
	};
}
