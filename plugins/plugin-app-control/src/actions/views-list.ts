/**
 * @module plugin-app-control/actions/views-list
 *
 * list sub-mode: fetch all registered views and format them for the agent
 * and calling client.
 */

import type { ActionResult, HandlerCallback } from "@elizaos/core";
import type { ViewSummary, ViewsClient } from "./views-client.js";

function formatViewTable(views: readonly ViewSummary[]): string {
	if (views.length === 0) {
		return ["available_views:", "  count: 0"].join("\n");
	}

	const lines: string[] = [];
	lines.push("available_views:");
	lines.push(`  count: ${views.length}`);
	lines.push(`views[${views.length}]{id,label,path,available}:`);
	for (const view of views) {
		const pathStr = view.path ?? "(no path)";
		const avail = view.available ? "yes" : "no";
		lines.push(`  ${view.id},${view.label},${pathStr},${avail}`);
	}
	return lines.join("\n");
}

export interface RunViewsListInput {
	client: ViewsClient;
	callback?: HandlerCallback;
}

export async function runViewsList({
	client,
	callback,
}: RunViewsListInput): Promise<ActionResult> {
	const views = await client.listViews();
	const text = formatViewTable(views);
	await callback?.({ text });
	return {
		success: true,
		text,
		values: { mode: "list", viewCount: views.length },
		data: { views },
	};
}
