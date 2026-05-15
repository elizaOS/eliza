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

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/core";
import type { ViewSummary, ViewsClient } from "./views-client.js";

export interface ScoredView {
	view: ViewSummary;
	score: number;
}

export function scoreView(view: ViewSummary, query: string): number {
	const q = query.trim().toLowerCase();
	if (!q) return 0;

	const label = view.label.toLowerCase();
	if (label === q) return 100;
	if (label.includes(q)) return 80;

	const tags = view.tags ?? [];
	if (tags.some((t) => t.toLowerCase() === q)) return 60;

	const description = (view.description ?? "").toLowerCase();
	if (description.includes(q)) return 40;

	return 0;
}

function formatSearchResults(
	results: readonly ScoredView[],
	query: string,
): string {
	if (results.length === 0) {
		return `No views found matching "${query}".`;
	}
	const lines: string[] = [`Views matching "${query}" (${results.length}):`];
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
): Promise<ScoredView[] | null> {
	try {
		const port = resolveServerOnlyPort(process.env);
		const url = new URL(`http://127.0.0.1:${port}/api/views/search`);
		url.searchParams.set("q", query);
		url.searchParams.set("limit", String(limit));

		const resp = await fetch(url.toString(), {
			signal: AbortSignal.timeout(5_000),
		});
		if (!resp.ok) return null;

		const body = (await resp.json()) as { results?: unknown[] };
		if (!Array.isArray(body.results)) return null;

		return body.results
			.filter(
				(r): r is Record<string, unknown> =>
					r !== null && typeof r === "object" && !Array.isArray(r),
			)
			.map((r) => ({
				view: r as unknown as ViewSummary,
				score: typeof r._score === "number" ? r._score : 0,
			}));
	} catch {
		return null;
	}
}

export interface RunViewsSearchInput {
	client: ViewsClient;
	query: string;
	callback?: HandlerCallback;
}

export async function runViewsSearch({
	client,
	query,
	callback,
}: RunViewsSearchInput): Promise<ActionResult> {
	if (!query.trim()) {
		const text =
			'Provide a search query to find views. Example: "search views wallet".';
		await callback?.({ text });
		return { success: false, text };
	}

	// Attempt hybrid semantic+keyword search via the server endpoint.
	const semanticResults = await fetchSemanticSearch(query, 5);
	if (semanticResults !== null) {
		const text = formatSearchResults(semanticResults, query);
		await callback?.({ text });
		return {
			success: true,
			text,
			values: { mode: "search", query, resultCount: semanticResults.length },
			data: { results: semanticResults },
		};
	}

	// Fallback: keyword-only scoring using the views client directly.
	const views = await client.listViews();
	const scored: ScoredView[] = views
		.map((view) => ({ view, score: scoreView(view, query) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);

	const text = formatSearchResults(scored, query);
	await callback?.({ text });
	return {
		success: true,
		text,
		values: { mode: "search", query, resultCount: scored.length },
		data: { results: scored },
	};
}
