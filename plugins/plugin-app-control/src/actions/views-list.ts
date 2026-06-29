/**
 * @module plugin-app-control/actions/views-list
 *
 * list sub-mode: fetch all registered views and format them for the agent
 * and calling client.
 */

import type { ActionResult, HandlerCallback, ViewType } from "@elizaos/core";
import { subviewsForView } from "./settings-subviews.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";

function formatViewTable(
	views: readonly ViewSummary[],
	viewType?: ViewType,
): string {
	if (views.length === 0) {
		return [
			"available_views:",
			`  type: ${viewType ?? "gui"}`,
			"  count: 0",
		].join("\n");
	}

	const lines: string[] = [];
	lines.push("available_views:");
	lines.push(`  type: ${viewType ?? "gui"}`);
	lines.push(`  count: ${views.length}`);
	lines.push(`views[${views.length}]{id,label,type,path,available}:`);
	for (const view of views) {
		const pathStr = view.path ?? "(no path)";
		const avail = view.available ? "yes" : "no";
		lines.push(
			`  ${view.id},${view.label},${view.viewType ?? "gui"},${pathStr},${avail}`,
		);
		// Surface addressable sub-sections (e.g. Settings sections) so the planner
		// can deep-link one via the VIEWS `subview` param.
		const subviews = subviewsForView(view.id);
		if (subviews && subviews.length > 0) {
			const rendered = subviews.map((s) => `${s.id}:${s.label}`).join(", ");
			lines.push(`    subviews[${subviews.length}]{id:label}: ${rendered}`);
		}
	}
	return lines.join("\n");
}

export interface RunViewsListInput {
	client: ViewsClient;
	viewType?: ViewType;
	callback?: HandlerCallback;
}

export async function runViewsList({
	client,
	viewType,
	callback,
}: RunViewsListInput): Promise<ActionResult> {
	const views = await client.listViews({ viewType });
	const text = formatViewTable(views, viewType);
	await callback?.({ text });
	const viewsWithSubviews = views.map((view) => {
		const subviews = subviewsForView(view.id);
		return subviews ? { ...view, subviews } : view;
	});
	return {
		success: true,
		text,
		values: {
			mode: "list",
			viewType: viewType ?? "gui",
			viewCount: views.length,
		},
		data: { views: viewsWithSubviews },
	};
}
