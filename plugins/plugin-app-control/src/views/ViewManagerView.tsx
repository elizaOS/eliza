/**
 * ViewManagerView — the "views" equivalent of the apps grid.
 *
 * Fetches GET /api/views and renders a card grid of all registered views.
 * Built as a standalone ES-module view bundle; loaded dynamically by the
 * frontend shell via `import("/api/views/views-manager/bundle.js")`.
 *
 * External dependencies (react, lucide-react, @elizaos/ui) are provided by the
 * shell host environment and externalized from this bundle.
 */

import { useAgentElement } from "@elizaos/ui";
import { LayoutGrid, PackageOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	fetchViewEntries,
	requestViewNavigation,
	type ViewEntry,
} from "./viewManagerData";

export { interact } from "./viewManagerData";

// ─── Sub-components ──────────────────────────────────────────────────────────

function ViewCard({ view }: { view: ViewEntry }) {
	const heroSrc =
		view.heroImageUrl ?? `/api/views/${encodeURIComponent(view.id)}/hero`;

	return (
		<div
			style={{
				border: "1px solid rgba(255,255,255,0.08)",
				borderRadius: 12,
				overflow: "hidden",
				background: "rgba(255,255,255,0.03)",
				display: "flex",
				flexDirection: "column",
				transition: "border-color 0.15s",
			}}
		>
			<img
				src={heroSrc}
				alt={view.label}
				style={{
					width: "100%",
					aspectRatio: "4/3",
					objectFit: "cover",
					display: "block",
					background: "#1a1a2e",
				}}
				onError={(e) => {
					// Hide broken image — the placeholder SVG served by the agent
					// renders via the src anyway; this guard handles network errors.
					(e.target as HTMLImageElement).style.display = "none";
				}}
			/>
			<div style={{ padding: "12px 16px 16px" }}>
				<div
					style={{
						fontWeight: 600,
						fontSize: 14,
						color: "#e0e0e0",
						marginBottom: 4,
					}}
				>
					{view.label}
				</div>
				{view.description && (
					<div
						style={{
							fontSize: 12,
							color: "rgba(255,255,255,0.45)",
							lineHeight: 1.4,
							marginBottom: 8,
						}}
					>
						{view.description}
					</div>
				)}
				<div
					style={{
						fontSize: 11,
						color: view.available
							? "rgba(110,231,183,0.8)"
							: "rgba(255,255,255,0.25)",
					}}
				>
					{view.available ? "Bundle ready" : "Not built"}
				</div>
			</div>
		</div>
	);
}

function EmptyState() {
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 12,
				padding: "64px 24px",
				color: "rgba(255,255,255,0.35)",
				textAlign: "center",
			}}
		>
			<PackageOpen size={48} strokeWidth={1.2} />
			<div style={{ fontSize: 15, fontWeight: 500 }}>No views registered</div>
			<div style={{ fontSize: 13, maxWidth: 320 }}>
				Views are UI bundles contributed by plugins. Install a plugin that
				declares views to see them here.
			</div>
		</div>
	);
}

function RefreshButton({
	loading,
	onClick,
}: {
	loading: boolean;
	onClick: () => void;
}) {
	const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
		id: "action-refresh",
		role: "button",
		label: "Refresh views",
		group: "view-manager-toolbar",
		status: loading ? "active" : "inactive",
		description: "Reload the list of registered plugin views",
	});
	return (
		<button
			ref={ref}
			type="button"
			onClick={onClick}
			disabled={loading}
			aria-label="Refresh views"
			{...agentProps}
			style={{
				background: "transparent",
				border: "1px solid rgba(255,255,255,0.12)",
				borderRadius: 8,
				color: "rgba(255,255,255,0.6)",
				cursor: loading ? "not-allowed" : "pointer",
				display: "flex",
				alignItems: "center",
				gap: 6,
				fontSize: 13,
				padding: "6px 12px",
			}}
		>
			<RefreshCw
				size={14}
				style={{
					animation: loading ? "spin 1s linear infinite" : "none",
				}}
			/>
			Refresh
		</button>
	);
}

// ─── Main component ──────────────────────────────────────────────────────────

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

	return (
		<div
			style={{
				minHeight: "100vh",
				background: "#0f0f1a",
				color: "#e0e0e0",
				fontFamily: "system-ui, -apple-system, sans-serif",
			}}
		>
			{/* Header */}
			<div
				style={{
					borderBottom: "1px solid rgba(255,255,255,0.06)",
					padding: "20px 24px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<LayoutGrid size={20} style={{ color: "#6c63ff" }} />
					<span style={{ fontWeight: 600, fontSize: 16 }}>View Manager</span>
					{!loading && (
						<span
							style={{
								fontSize: 12,
								color: "rgba(255,255,255,0.35)",
								marginLeft: 4,
							}}
						>
							{views.length} view{views.length !== 1 ? "s" : ""}
						</span>
					)}
				</div>
				<RefreshButton loading={loading} onClick={() => void fetchViews()} />
			</div>

			{/* Body */}
			<div style={{ padding: "24px" }}>
				{loading && (
					<div
						style={{
							textAlign: "center",
							padding: "48px 0",
							color: "rgba(255,255,255,0.35)",
							fontSize: 14,
						}}
					>
						Loading views…
					</div>
				)}

				{!loading && error && (
					<div
						style={{
							textAlign: "center",
							padding: "48px 0",
							color: "rgba(239,68,68,0.8)",
							fontSize: 14,
						}}
					>
						{error}
					</div>
				)}

				{!loading && !error && views.length === 0 && <EmptyState />}

				{!loading && !error && views.length > 0 && (
					<div
						style={{
							display: "grid",
							gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
							gap: 16,
						}}
					>
						{views.map((view) => (
							<ViewCard key={view.id} view={view} />
						))}
					</div>
				)}
			</div>

			{/* Spin keyframe — injected once */}
			<style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
		</div>
	);
}

export default ViewManagerView;

function TuiStatusBadge({ view }: { view: ViewEntry }) {
	return (
		<span
			style={{
				color: view.available ? "#7dd3fc" : "#fca5a5",
				minWidth: 10,
				display: "inline-block",
			}}
		>
			{view.available ? "ready" : "missing"}
		</span>
	);
}

function TuiRefreshButton({
	loading,
	onClick,
}: {
	loading: boolean;
	onClick: () => void;
}) {
	const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
		id: "tui-action-refresh",
		role: "button",
		label: "Refresh TUI views",
		group: "view-manager-tui-toolbar",
		status: loading ? "active" : "inactive",
		description: "Reload the list of registered terminal (TUI) views",
	});
	return (
		<button
			ref={ref}
			type="button"
			onClick={onClick}
			disabled={loading}
			aria-label="Refresh TUI views"
			{...agentProps}
			style={{
				background: "transparent",
				color: "#a7f3d0",
				border: "1px solid rgba(167,243,208,0.45)",
				borderRadius: 4,
				padding: "4px 8px",
				cursor: loading ? "not-allowed" : "pointer",
				fontFamily: "inherit",
			}}
		>
			refresh
		</button>
	);
}

function TuiViewRow({
	view,
	index,
	onOpen,
}: {
	view: ViewEntry;
	index: number;
	onOpen: (view: ViewEntry) => void;
}) {
	const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
		id: `open-view-${view.id}`,
		role: "button",
		label: `Open ${view.label}`,
		group: "view-manager-tui-rows",
		description: `Navigate to the ${view.label} view`,
	});
	return (
		<div
			style={{
				display: "grid",
				gridTemplateColumns: "4ch minmax(10ch, 24ch) 8ch minmax(12ch, 1fr) 8ch",
				gap: 12,
				alignItems: "center",
				padding: "8px 0",
				borderTop: index === 0 ? "none" : "1px solid rgba(125,211,252,0.18)",
			}}
		>
			<span style={{ color: "#64748b" }}>
				{String(index + 1).padStart(2, "0")}
			</span>
			<span style={{ color: "#e2e8f0", fontWeight: 700 }}>{view.label}</span>
			<span style={{ color: "#a7f3d0" }}>{view.viewType ?? "gui"}</span>
			<span
				style={{
					color: "#94a3b8",
					overflow: "hidden",
					textOverflow: "ellipsis",
				}}
			>
				{view.id}
			</span>
			<TuiStatusBadge view={view} />
			<div style={{ gridColumn: "2 / 5", color: "#94a3b8", fontSize: 12 }}>
				{view.description ?? view.pluginName}
			</div>
			<button
				ref={ref}
				type="button"
				onClick={() => onOpen(view)}
				aria-label={`Open ${view.label}`}
				{...agentProps}
				style={{
					gridColumn: "5",
					gridRow: "1 / span 2",
					background: "transparent",
					color: "#7dd3fc",
					border: "1px solid rgba(125,211,252,0.45)",
					borderRadius: 4,
					padding: "4px 8px",
					cursor: "pointer",
					fontFamily: "inherit",
				}}
			>
				open
			</button>
		</div>
	);
}

export function ViewManagerTuiView() {
	const [views, setViews] = useState<ViewEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [lastAction, setLastAction] = useState<string>("ready");

	const fetchViews = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setViews(await fetchViewEntries("tui"));
			setLastAction("refreshed");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load views");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchViews();
	}, [fetchViews]);

	const openView = useCallback((view: ViewEntry) => {
		void requestViewNavigation(view)
			.then(() => setLastAction(`opened ${view.id}`))
			.catch((err) =>
				setLastAction(
					`open failed: ${err instanceof Error ? err.message : String(err)}`,
				),
			);
	}, []);

	return (
		<div
			data-view-state={JSON.stringify({
				viewType: "tui",
				viewCount: views.length,
				lastAction,
			})}
			style={{
				minHeight: "100vh",
				background: "#020617",
				color: "#cbd5e1",
				fontFamily:
					'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
				padding: 20,
			}}
		>
			<div style={{ color: "#7dd3fc", marginBottom: 4 }}>
				elizaos://views-manager --type=tui
			</div>
			<div
				data-status={lastAction}
				style={{ color: "#475569", marginBottom: 16 }}
			>
				{loading ? "loading" : `${views.length} entries`} | {lastAction}
			</div>

			<div
				style={{
					border: "1px solid rgba(125,211,252,0.3)",
					borderRadius: 6,
					padding: 16,
					boxShadow: "inset 0 0 0 1px rgba(15,23,42,0.8)",
				}}
			>
				<div
					style={{
						display: "flex",
						justifyContent: "space-between",
						alignItems: "center",
						marginBottom: 10,
					}}
				>
					<strong style={{ color: "#e2e8f0" }}>registered tui views</strong>
					<TuiRefreshButton
						loading={loading}
						onClick={() => void fetchViews()}
					/>
				</div>

				{error && <div style={{ color: "#fca5a5" }}>{error}</div>}
				{!error && views.length === 0 && !loading && (
					<div style={{ color: "#64748b" }}>no tui views registered</div>
				)}
				{views.map((view, index) => (
					<TuiViewRow
						key={`${view.viewType ?? "gui"}:${view.id}`}
						view={view}
						index={index}
						onOpen={openView}
					/>
				))}
			</div>
		</div>
	);
}
