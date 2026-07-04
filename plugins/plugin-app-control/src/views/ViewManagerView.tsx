/**
 * ViewManagerView — the single GUI/XR data wrapper for the "views" surface (the
 * "views view"): the deduped manager that fetches GET /api/views and lists every
 * registered view (collapsed one row per logical id with modality chips and
 * per-view open/available state).
 *
 * It owns the live view list (fetch + loading/error state and the open→navigate
 * handoff) and renders the one presentational {@link ViewManagerSpatialView}
 * inside a {@link SpatialSurface}. Omitting the `modality` prop lets
 * `SpatialSurface` auto-detect GUI vs XR via `window.__elizaXRContext`, so the
 * SAME component serves both surfaces. The TUI surface renders the same
 * `ViewManagerSpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 *
 * Built as a standalone ES-module view bundle; loaded dynamically by the
 * frontend shell via `import("/api/views/views-manager/bundle.js")`. External
 * dependencies (react, @elizaos/ui) are provided by the shell host environment
 * and externalized from this bundle.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { useViewEvent, VIEW_EVENTS } from "@elizaos/ui/events";
import { useCallback, useEffect, useState } from "react";
import {
	type ViewManagerSnapshot,
	ViewManagerSpatialView,
} from "../components/ViewManagerSpatialView.tsx";
import {
	fetchViewEntries,
	requestViewNavigation,
	type ViewEntry,
} from "./viewManagerData";

const CONTROL_BTN =
	"inline-flex items-center justify-center rounded-md border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-strong transition-colors hover:bg-bg-hover hover:text-txt disabled:pointer-events-none disabled:opacity-50";

export function ViewManagerView() {
	const [views, setViews] = useState<ViewEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchViews = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setViews(await fetchViewEntries());
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load views");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchViews();
	}, [fetchViews]);
	useViewEvent(VIEW_EVENTS.PLUGIN_RELOADED, () => {
		void fetchViews();
	}, [fetchViews]);

	const openView = useCallback((view: ViewEntry) => {
		void requestViewNavigation(view);
	}, []);

	const refreshControl = useAgentElement<HTMLButtonElement>({
		id: "views-manager-refresh",
		role: "button",
		label: "Refresh views",
		group: "views-manager",
		description: "Reload the registered views list",
		status: loading ? "active" : "inactive",
		onActivate: () => {
			void fetchViews();
		},
	});

	const snapshot: ViewManagerSnapshot = { views, loading, error };

	return (
		<div className="flex flex-col gap-2">
			<div className="flex justify-end">
				<Button
					unstyled
					type="button"
					ref={refreshControl.ref}
					{...refreshControl.agentProps}
					onClick={() => void fetchViews()}
					disabled={loading}
					aria-label="Refresh views"
					className={CONTROL_BTN}
				>
					{loading ? "Refreshing…" : "Refresh"}
				</Button>
			</div>
			<ViewManagerSpatialView snapshot={snapshot} onOpenView={openView} />
		</div>
	);
}

export default ViewManagerView;
