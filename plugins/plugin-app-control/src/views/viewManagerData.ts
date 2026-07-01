/**
 * Pure data layer for the View Manager bundle.
 *
 * Holds the view shape and the fetch/navigate/capability logic with no React or
 * `@elizaos/ui` imports, so it can be unit-tested in a plain Node environment
 * without dragging the shell-host UI dependency chain into the test runtime.
 */

/**
 * A surface a view renders on. Mirrors `ViewModality` in `@elizaos/core`; kept
 * local so this bundle (built against core's published dist) doesn't depend on a
 * just-landed core export being present in that dist.
 */
export type ViewModality = "gui" | "tui" | "xr";

const MODALITY_ORDER: readonly ViewModality[] = ["gui", "xr", "tui"];

/** Order + de-duplicate a modality list as gui, xr, tui (matches core). */
function dedupeModalities(mods: readonly ViewModality[]): ViewModality[] {
	const seen = new Set(mods);
	return MODALITY_ORDER.filter((m) => seen.has(m));
}

export interface ViewEntry {
	id: string;
	label: string;
	viewType?: ViewModality;
	/**
	 * Every surface this logical view renders on. A raw `/api/views` entry has
	 * `[viewType]`; after {@link collapseViewEntries} it carries the union of all
	 * same-id declarations (e.g. `["gui", "xr", "tui"]`) so the manager lists the
	 * view ONCE with modality badges instead of one duplicate row per surface.
	 */
	modalities?: ViewModality[];
	description?: string;
	icon?: string;
	path?: string;
	order?: number;
	available: boolean;
	bundleUrl?: string;
	heroImageUrl?: string;
	pluginName: string;
}

/**
 * Collapse `/api/views` entries that share an `id` into one logical row carrying
 * the union of every surface (`gui`/`xr`/`tui`) they render on. The GUI entry is
 * preferred as the base (clean label, no surface suffix); first-seen order is
 * preserved. This is what makes a view appear ONCE with modality badges instead
 * of duplicate "Phone" / "Phone XR" / "Phone TUI" rows.
 */
export function collapseViewEntries(entries: ViewEntry[]): ViewEntry[] {
	const order: string[] = [];
	const byId = new Map<string, ViewEntry>();
	for (const entry of entries) {
		const mods = entry.modalities ?? [entry.viewType ?? "gui"];
		const existing = byId.get(entry.id);
		if (!existing) {
			order.push(entry.id);
			byId.set(entry.id, { ...entry, modalities: dedupeModalities(mods) });
			continue;
		}
		const merged = dedupeModalities([
			...(existing.modalities ?? [existing.viewType ?? "gui"]),
			...mods,
		]);
		const isGui = (entry.viewType ?? "gui") === "gui";
		const baseWasGui = (existing.viewType ?? "gui") === "gui";
		const base = isGui && !baseWasGui ? entry : existing;
		byId.set(entry.id, { ...base, modalities: merged });
	}
	return order.map((id) => byId.get(id) as ViewEntry);
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
