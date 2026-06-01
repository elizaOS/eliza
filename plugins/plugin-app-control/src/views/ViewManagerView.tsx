/**
 * ViewManagerView — the "views" equivalent of the apps grid.
 *
 * Fetches GET /api/views and renders a card grid of all registered views.
 * Built as a standalone ES-module view bundle; loaded dynamically by the
 * frontend shell via `import("/api/views/views-manager/bundle.js")`.
 *
 * External dependencies (react, lucide-react) are provided by the shell host
 * environment. No @elizaos/ui import — this bundle must stay self-contained.
 */

import { useAgentElement } from "@elizaos/ui";
import {
	CheckCircle2,
	ExternalLink,
	LayoutGrid,
	PackageOpen,
	RefreshCw,
	XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ViewEntry {
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

const viewManagerTheme = {
	page: "var(--background, var(--bg, Canvas))",
	panel: "var(--card, color-mix(in srgb, Canvas 94%, CanvasText 6%))",
	panelMuted:
		"var(--muted, color-mix(in srgb, Canvas 90%, CanvasText 10%))",
	text: "var(--foreground, var(--txt, CanvasText))",
	muted:
		"var(--muted-foreground, color-mix(in srgb, CanvasText 58%, transparent))",
	subtle:
		"var(--muted-foreground, color-mix(in srgb, CanvasText 38%, transparent))",
	border: "var(--border, color-mix(in srgb, CanvasText 14%, transparent))",
	borderStrong:
		"var(--border, color-mix(in srgb, CanvasText 24%, transparent))",
	accent: "var(--accent, Highlight)",
	accentSoft: "color-mix(in srgb, var(--accent, Highlight) 16%, transparent)",
	accentBorder:
		"color-mix(in srgb, var(--accent, Highlight) 38%, transparent)",
	success: "var(--ok, var(--success, #16a34a))",
	danger: "var(--danger, var(--destructive, #dc2626))",
	dangerSoft:
		"color-mix(in srgb, var(--danger, var(--destructive, #dc2626)) 14%, transparent)",
};

async function fetchViewEntries(
	viewType?: "gui" | "tui" | "xr",
): Promise<ViewEntry[]> {
	const qs = viewType ? `?viewType=${viewType}` : "";
	const res = await fetch(`/api/views${qs}`);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const data = (await res.json()) as { views: ViewEntry[] };
	return Array.isArray(data.views) ? data.views : [];
}

async function requestViewNavigation(
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

// ─── Sub-components ──────────────────────────────────────────────────────────

function ViewCard({
	view,
	onOpen,
}: {
	view: ViewEntry;
	onOpen: (view: ViewEntry) => void;
}) {
	const heroSrc =
		view.heroImageUrl ?? `/api/views/${encodeURIComponent(view.id)}/hero`;
	const typeLabel = (view.viewType ?? "gui").toUpperCase();
	const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
		id: `launch-view-${view.viewType ?? "gui"}-${view.id}`,
		role: "button",
		label: `Open ${view.label}`,
		group: "view-manager-cards",
		status: view.available ? "active" : "inactive",
		description: `Navigate to the ${view.label} ${typeLabel} view`,
	});

	return (
		<div
			title={view.description ?? view.pluginName}
			style={{
				border: `1px solid ${viewManagerTheme.border}`,
				borderRadius: 8,
				overflow: "hidden",
				background: viewManagerTheme.panel,
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
					background: viewManagerTheme.panelMuted,
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
						color: viewManagerTheme.text,
						marginBottom: 4,
					}}
				>
					{view.label}
				</div>
				<div
					style={{
						display: "flex",
						flexWrap: "wrap",
						gap: 6,
						marginBottom: 8,
					}}
				>
					<span
						style={{
							fontSize: 12,
							color: viewManagerTheme.muted,
							border: `1px solid ${viewManagerTheme.border}`,
							borderRadius: 999,
							padding: "3px 8px",
						}}
					>
						{typeLabel}
					</span>
					<span
						style={{
							fontSize: 12,
							color: viewManagerTheme.subtle,
							border: `1px solid ${viewManagerTheme.border}`,
							borderRadius: 999,
							padding: "3px 8px",
							maxWidth: "100%",
							overflow: "hidden",
							textOverflow: "ellipsis",
							whiteSpace: "nowrap",
						}}
					>
						{view.pluginName.replace(/^@elizaos\//, "")}
					</span>
				</div>
				<span
					style={{
						display: "inline-flex",
						alignItems: "center",
						gap: 6,
						fontSize: 11,
						color: view.available
							? viewManagerTheme.success
							: viewManagerTheme.subtle,
					}}
				>
					{view.available ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
					{view.available ? "Ready" : "Missing"}
				</span>
				<button
					ref={ref}
					type="button"
					onClick={() => onOpen(view)}
					disabled={!view.available}
					aria-label={`Open ${view.label}`}
					title={`Open ${view.label}`}
					{...agentProps}
					style={{
						float: "right",
						display: "inline-grid",
						placeItems: "center",
						width: 30,
						height: 30,
						border: `1px solid ${viewManagerTheme.accentBorder}`,
						borderRadius: 6,
						background: view.available
							? viewManagerTheme.accentSoft
							: viewManagerTheme.panelMuted,
						color: view.available
							? viewManagerTheme.accent
							: viewManagerTheme.subtle,
						cursor: view.available ? "pointer" : "not-allowed",
					}}
				>
					<ExternalLink size={14} aria-hidden="true" />
				</button>
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
				color: viewManagerTheme.subtle,
				textAlign: "center",
			}}
		>
			<PackageOpen size={48} strokeWidth={1.2} />
			<div style={{ fontSize: 15, fontWeight: 500 }}>No views registered</div>
			<div style={{ fontSize: 13 }}>Install a view plugin</div>
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
				border: `1px solid ${viewManagerTheme.borderStrong}`,
				borderRadius: 8,
				color: viewManagerTheme.muted,
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

	const openView = useCallback((view: ViewEntry) => {
		void requestViewNavigation(view);
	}, []);

	return (
		<div
			style={{
				minHeight: "100vh",
				background: viewManagerTheme.page,
				color: viewManagerTheme.text,
				fontFamily: "system-ui, -apple-system, sans-serif",
			}}
		>
			{/* Header */}
			<div
				style={{
					borderBottom: `1px solid ${viewManagerTheme.border}`,
					padding: "20px 24px",
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<LayoutGrid size={20} style={{ color: viewManagerTheme.accent }} />
					<span style={{ fontWeight: 600, fontSize: 16 }}>View Manager</span>
					{!loading && (
						<span
							style={{
								fontSize: 12,
								color: viewManagerTheme.subtle,
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
							color: viewManagerTheme.subtle,
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
							color: viewManagerTheme.danger,
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
							<ViewCard key={view.id} view={view} onOpen={openView} />
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
			title={view.available ? "Ready" : "Missing"}
			style={{
				color: view.available
					? viewManagerTheme.success
					: viewManagerTheme.danger,
				minWidth: 18,
				display: "inline-flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			{view.available ? (
				<CheckCircle2 size={14} aria-hidden="true" />
			) : (
				<XCircle size={14} aria-hidden="true" />
			)}
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
				color: viewManagerTheme.accent,
				border: `1px solid ${viewManagerTheme.accentBorder}`,
				borderRadius: 4,
				padding: "4px 8px",
				cursor: loading ? "not-allowed" : "pointer",
				fontFamily: "inherit",
			}}
		>
			<RefreshCw
				size={14}
				aria-hidden="true"
				style={{ animation: loading ? "spin 1s linear infinite" : "none" }}
			/>
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
				borderTop: index === 0 ? "none" : `1px solid ${viewManagerTheme.border}`,
			}}
		>
			<span style={{ color: viewManagerTheme.subtle }}>
				{String(index + 1).padStart(2, "0")}
			</span>
			<span style={{ color: viewManagerTheme.text, fontWeight: 700 }}>
				{view.label}
			</span>
			<span style={{ color: viewManagerTheme.accent }}>
				{view.viewType ?? "gui"}
			</span>
			<span
				style={{
					color: viewManagerTheme.muted,
					overflow: "hidden",
					textOverflow: "ellipsis",
				}}
			>
				{view.id}
			</span>
			<TuiStatusBadge view={view} />
			<div
				title={view.description ?? view.pluginName}
				style={{
					gridColumn: "2 / 5",
					display: "flex",
					gap: 8,
					color: viewManagerTheme.muted,
					fontSize: 12,
				}}
			>
				<span>{view.pluginName.replace(/^@elizaos\//, "")}</span>
				<span style={{ color: viewManagerTheme.subtle }}>
					{view.path ?? "/"}
				</span>
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
					color: viewManagerTheme.accent,
					border: `1px solid ${viewManagerTheme.accentBorder}`,
					borderRadius: 4,
					padding: "4px 8px",
					cursor: "pointer",
					fontFamily: "inherit",
				}}
			>
				<ExternalLink size={14} aria-hidden="true" />
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
				background: viewManagerTheme.page,
				color: viewManagerTheme.text,
				fontFamily:
					'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
				padding: 20,
			}}
		>
			<div style={{ color: viewManagerTheme.accent, marginBottom: 4 }}>
				elizaos://views-manager --type=tui
			</div>
			<div
				data-status={lastAction}
				style={{ color: viewManagerTheme.subtle, marginBottom: 16 }}
			>
				{loading ? "loading" : `${views.length} entries`} | {lastAction}
			</div>

			<div
				style={{
					border: `1px solid ${viewManagerTheme.borderStrong}`,
					borderRadius: 6,
					padding: 16,
					background: viewManagerTheme.panel,
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
					<strong style={{ color: viewManagerTheme.text }}>
						registered tui views
					</strong>
					<TuiRefreshButton
						loading={loading}
						onClick={() => void fetchViews()}
					/>
				</div>

				{error && <div style={{ color: viewManagerTheme.danger }}>{error}</div>}
				{!error && views.length === 0 && !loading && (
					<div style={{ color: viewManagerTheme.subtle }}>
						no tui views registered
					</div>
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
