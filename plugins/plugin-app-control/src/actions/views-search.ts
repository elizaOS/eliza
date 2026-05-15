/**
 * @module plugin-app-control/actions/views-search
 *
 * search sub-mode: score and rank views by keyword relevance against label,
 * description, and tags. No embedding — pure keyword scoring.
 *
 * Scoring:
 *   100 — exact label match
 *    80 — label contains query
 *    60 — tag exact match
 *    40 — description contains query
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { ViewsClient, ViewSummary } from "./views-client.js";

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

function formatSearchResults(results: readonly ScoredView[], query: string): string {
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
		const text = "Provide a search query to find views. Example: \"search views wallet\".";
		await callback?.({ text });
		return { success: false, text };
	}

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
