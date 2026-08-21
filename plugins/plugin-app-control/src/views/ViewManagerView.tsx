/**
 * Connects the registered-view catalog to its spatial manager surface.
 * It owns fetch, loading, error, reload, and open-to-navigation state while the
 * presentational component remains transport-agnostic. The shell loads this as
 * a standalone ES module and supplies its external React and UI dependencies.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import {
	dispatchNavigateViewEvent,
	useViewEvent,
	VIEW_EVENTS,
} from "@elizaos/ui/events";
import { useCallback, useEffect, useRef, useState } from "react";
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
	const [openingViewId, setOpeningViewId] = useState<string | null>(null);
	const listControllerRef = useRef<AbortController | null>(null);

	const fetchViews = useCallback(async () => {
		listControllerRef.current?.abort();
		const controller = new AbortController();
		listControllerRef.current = controller;
		setLoading(true);
		setError(null);
		try {
			const nextViews = await fetchViewEntries(undefined, controller.signal);
			if (listControllerRef.current === controller) setViews(nextViews);
		} catch (err) {
			if (!controller.signal.aborted) {
				setError(err instanceof Error ? err.message : "Failed to load views");
			}
		} finally {
			if (listControllerRef.current === controller) {
				listControllerRef.current = null;
				setLoading(false);
			}
		}
	}, []);

	useEffect(() => {
		void fetchViews();
		return () => {
			listControllerRef.current?.abort();
			listControllerRef.current = null;
		};
	}, [fetchViews]);
	useViewEvent(VIEW_EVENTS.PLUGIN_RELOADED, () => {
		void fetchViews();
	}, [fetchViews]);

	const openView = useCallback(async (view: ViewEntry) => {
		setOpeningViewId(view.id);
		setError(null);
		try {
			// A user click navigates locally after the server records current-view
			// state. This works on Cloud/mobile transports that intentionally have no
			// WebSocket, and `source:user` prevents a duplicate server echo.
			await requestViewNavigation(view, { source: "user" });
			dispatchNavigateViewEvent({
				viewId: view.id,
				...(view.path ? { viewPath: view.path } : {}),
				viewLabel: view.label,
				viewType: view.viewType ?? "gui",
			});
		} catch (err) {
			// error-policy:J4 the manager keeps the catalog visible and renders a
			// distinct open failure instead of pretending navigation succeeded.
			setError(err instanceof Error ? err.message : "Could not open view");
		} finally {
			setOpeningViewId(null);
		}
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

	const snapshot: ViewManagerSnapshot = {
		views,
		loading,
		error,
		openingViewId,
	};

	return (
		<div className="eliza-chat-scroll h-0 min-h-0 flex-1 overflow-y-auto">
			<div className="mb-2 flex justify-end">
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
