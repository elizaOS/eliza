/**
 * Pure data layer for the View Manager bundle.
 *
 * Holds the view shape and the fetch/navigate/capability logic with no React or
 * `@elizaos/ui` imports, so it can be unit-tested in a plain Node environment
 * without dragging the shell-host UI dependency chain into the test runtime.
 */

export interface ViewEntry {
	id: string;
	label: string;
	viewType?: "gui" | "tui" | "xr";
	description?: string;
	icon?: string;
	path?: string;
	order?: number;
	available: boolean;
	bundleUrl?: string;
	heroImageUrl?: string;
	pluginName: string;
}

export async function fetchViewEntries(
	viewType?: "gui" | "tui" | "xr",
): Promise<ViewEntry[]> {
	const qs = viewType ? `?viewType=${viewType}` : "";
	const res = await fetch(`/api/views${qs}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { views: ViewEntry[] };
	return Array.isArray(data.views) ? data.views : [];
}

export async function requestViewNavigation(
	view: Pick<ViewEntry, "id" | "path" | "viewType">,
) {
	await fetch(
		`/api/views/${encodeURIComponent(view.id)}/navigate${
			view.viewType ? `?viewType=${view.viewType}` : ""
		}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: view.path, viewType: view.viewType }),
		},
	);
}

export async function interact(
	capability: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	if (capability === "terminal-list-views") {
		return { views: await fetchViewEntries("tui") };
	}
	if (capability === "terminal-open-view") {
		const viewId = typeof params?.viewId === "string" ? params.viewId : null;
		if (!viewId) throw new Error("viewId is required");
		const views = await fetchViewEntries("tui");
		const view = views.find((entry) => entry.id === viewId);
		if (!view) throw new Error(`View "${viewId}" not found`);
		await requestViewNavigation(view);
		return { opened: true, viewId, viewType: view.viewType ?? "gui" };
	}
	throw new Error(`Unsupported capability "${capability}"`);
}
