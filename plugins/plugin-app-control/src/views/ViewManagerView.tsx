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

import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
	Check,
	Circle,
	LayoutGrid,
	PackageOpen,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	fetchViewEntries,
	requestViewNavigation,
	type ViewEntry,
} from "./viewManagerData";

export { interact } from "./viewManagerData";

// Shell theme tokens — inherit the host shell chrome instead of hardcoding a
// dark cyan palette. Fallbacks avoid the forbidden literal colors.
const viewManagerTheme = {
	background: "var(--background)",
	surface: "var(--card)",
	surfaceMuted: "var(--muted)",
	border: "var(--border)",
	borderAccent: "var(--accent)",
	foreground: "var(--foreground)",
	muted: "var(--muted-foreground)",
	accent: "var(--accent)",
	success: "var(--success, #34d399)",
	danger: "var(--destructive)",
	shadowInset: "var(--ring, #1e293b)",
};

// ─── Sub-components ──────────────────────────────────────────────────────────

function ViewCard({
	view,
	onOpen,
}: {
	view: ViewEntry;
	onOpen: (view: ViewEntry) => void;
}) {
	const viewType = view.viewType ?? "gui";
	const statusLabel = view.available ? "Bundle ready" : "Not built";
	const description =
		view.description?.trim() ||
		`Open the ${view.label} ${viewType.toUpperCase()} view.`;
	const context = buildViewContext(view);
	const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
		id: `open-card-${view.id}`,
		role: "card",
		label: `Open ${view.label}`,
		group: "view-manager-grid",
		status: view.available ? "active" : "inactive",
		description: context.agentDescription,
		onActivate: () => onOpen(view),
	});

	return (
		<button
			ref={ref}
			type="button"
			onClick={() => onOpen(view)}
			aria-label={`Open ${view.label}`}
			{...agentProps}
			data-view-context={JSON.stringify(context)}
			style={{
				textAlign: "left",
				font: "inherit",
				border: `1px solid ${viewManagerTheme.border}`,
				borderRadius: 8,
				background: viewManagerTheme.surface,
				cursor: "pointer",
				padding: 16,
				transition: "border-color 0.15s, background 0.15s",
				minHeight: 172,
				display: "grid",
				gridTemplateRows: "auto 1fr auto",
				gap: 14,
			}}
		>
			<div
				style={{
					display: "flex",
					alignItems: "flex-start",
					justifyContent: "space-between",
					gap: 12,
				}}
			>
				<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
					<ViewGlyph view={view} />
					<div style={{ minWidth: 0 }}>
						<div
							style={{
								fontWeight: 650,
								fontSize: 14,
								color: viewManagerTheme.foreground,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								maxWidth: 220,
							}}
						>
							{view.label}
						</div>
						<div
							style={{
								marginTop: 2,
								fontSize: 11,
								color: viewManagerTheme.muted,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap",
								maxWidth: 240,
							}}
						>
							{view.pluginName}
						</div>
					</div>
				</div>
				<ViewStatus available={view.available} />
			</div>

			<div>
				<p
					style={{
						margin: 0,
						fontSize: 12,
						color: viewManagerTheme.muted,
						lineHeight: 1.45,
						display: "-webkit-box",
						WebkitLineClamp: 3,
						WebkitBoxOrient: "vertical",
						overflow: "hidden",
					}}
				>
					{description}
				</p>
			</div>

			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 10,
				}}
			>
				<div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
					<ViewBadge>{viewType.toUpperCase()}</ViewBadge>
					<ViewBadge>{statusLabel}</ViewBadge>
				</div>
				<div
					style={{
						color: viewManagerTheme.accent,
						fontSize: 12,
						fontWeight: 600,
					}}
				>
					Open
				</div>
			</div>
		</button>
	);
}

function ViewGlyph({ view }: { view: ViewEntry }) {
	const letter = view.label.trim().charAt(0).toUpperCase() || "?";
	return (
		<div
			aria-hidden="true"
			style={{
				width: 42,
				height: 42,
				borderRadius: 8,
				border: `1px solid ${viewManagerTheme.border}`,
				background: viewManagerTheme.surfaceMuted,
				color: viewManagerTheme.foreground,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				fontWeight: 700,
				fontSize: 15,
				flexShrink: 0,
			}}
		>
			{letter}
		</div>
	);
}

function ViewBadge({ children }: { children: string }) {
	return (
		<span
			style={{
				border: `1px solid ${viewManagerTheme.border}`,
				borderRadius: 999,
				padding: "3px 7px",
				fontSize: 10,
				fontWeight: 650,
				color: viewManagerTheme.muted,
				lineHeight: 1,
				whiteSpace: "nowrap",
			}}
		>
			{children}
		</span>
	);
}

function ViewStatus({ available }: { available: boolean }) {
	const Icon = available ? Check : Circle;
	return (
		<span
			title={available ? "Bundle ready" : "Bundle missing"}
			style={{
				width: 26,
				height: 26,
				borderRadius: 999,
				border: `1px solid ${viewManagerTheme.border}`,
				color: available ? viewManagerTheme.success : viewManagerTheme.muted,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				flexShrink: 0,
			}}
		>
			<Icon size={14} strokeWidth={2.2} aria-hidden="true" />
		</span>
	);
}

function buildViewContext(view: ViewEntry) {
	const viewType = view.viewType ?? "gui";
	const status = view.available ? "bundle ready" : "bundle missing";
	const route = view.path ?? `/views/${view.id}`;
	return {
		id: view.id,
		label: view.label,
		viewType,
		pluginName: view.pluginName,
		route,
		status,
		description: view.description ?? null,
		agentDescription: [
			`Open ${view.label}.`,
			`Type: ${viewType}.`,
			`Plugin: ${view.pluginName}.`,
			`Route: ${route}.`,
			`Status: ${status}.`,
			view.description ? `Purpose: ${view.description}.` : "",
		]
			.filter(Boolean)
			.join(" "),
	};
}

function viewMatchesSearch(view: ViewEntry, query: string) {
	if (!query) return true;
	const haystack = [
		view.id,
		view.label,
		view.description,
		view.pluginName,
		view.path,
		view.viewType ?? "gui",
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
	return haystack.includes(query.toLowerCase());
}

function groupViews(views: ViewEntry[]) {
	const core = views.filter((view) => view.pluginName === "app-control");
	const pluginViews = views.filter((view) => view.pluginName !== "app-control");
	return [
		{ key: "core", label: "Core", views: core },
		{ key: "plugins", label: "Plugin views", views: pluginViews },
	].filter((section) => section.views.length > 0);
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
				color: viewManagerTheme.muted,
				textAlign: "center",
			}}
		>
			<PackageOpen size={48} strokeWidth={1.2} />
			<div style={{ fontSize: 15, fontWeight: 500 }}>No views registered</div>
			<div style={{ fontSize: 13, maxWidth: 320 }}>
				Views are UI bundles contributed by plugins. Install or build a plugin
				that declares views to see them here.
			</div>
		</div>
	);
}

function SearchEmptyState({ query }: { query: string }) {
	return (
		<div
			style={{
				border: `1px dashed ${viewManagerTheme.border}`,
				borderRadius: 8,
				padding: "40px 24px",
				textAlign: "center",
				color: viewManagerTheme.muted,
				background: viewManagerTheme.surface,
			}}
		>
			<div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
				No views match “{query}”
			</div>
			<div style={{ fontSize: 12 }}>
				Search labels, plugin names, routes, descriptions, or view types.
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
				border: `1px solid ${viewManagerTheme.border}`,
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
	const [searchQuery, setSearchQuery] = useState("");

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

	const trimmedSearchQuery = searchQuery.trim();
	const filteredViews = useMemo(
		() => views.filter((view) => viewMatchesSearch(view, trimmedSearchQuery)),
		[trimmedSearchQuery, views],
	);
	const groupedViews = useMemo(
		() => groupViews(filteredViews),
		[filteredViews],
	);
	const readyCount = views.filter((view) => view.available).length;
	const typeCounts = views.reduce(
		(counts, view) => {
			const viewType = view.viewType ?? "gui";
			counts[viewType] += 1;
			return counts;
		},
		{ gui: 0, tui: 0, xr: 0 },
	);
	const { ref: searchRef, agentProps: searchAgentProps } =
		useAgentElement<HTMLInputElement>({
			id: "view-search",
			role: "text-input",
			label: "Search views",
			group: "view-manager-toolbar",
			description:
				"Filter the view directory by label, plugin, route, type, or description.",
			status: trimmedSearchQuery ? "active" : "inactive",
			getValue: () => searchQuery,
			onFill: setSearchQuery,
		});

	return (
		<div
			data-view-state={JSON.stringify({
				viewType: "gui",
				viewCount: views.length,
				filteredViewCount: filteredViews.length,
				readyCount,
				searchQuery: trimmedSearchQuery,
			})}
			style={{
				minHeight: "100vh",
				background: viewManagerTheme.background,
				color: viewManagerTheme.foreground,
				fontFamily: "system-ui, -apple-system, sans-serif",
				paddingBottom: 96,
			}}
		>
			{/* Header */}
			<div
				style={{
					borderBottom: `1px solid ${viewManagerTheme.border}`,
					padding: "18px 24px 16px",
				}}
			>
				<div
					style={{
						display: "flex",
						alignItems: "flex-start",
						justifyContent: "space-between",
						gap: 16,
						flexWrap: "wrap",
					}}
				>
					<div style={{ minWidth: 220 }}>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								gap: 10,
								marginBottom: 8,
							}}
						>
							<LayoutGrid
								size={20}
								style={{ color: viewManagerTheme.accent }}
							/>
							<span style={{ fontWeight: 700, fontSize: 18 }}>Views</span>
						</div>
						<div
							style={{
								color: viewManagerTheme.muted,
								fontSize: 12,
								lineHeight: 1.45,
								maxWidth: 520,
							}}
						>
							Browse available app surfaces, inspect where they come from, and
							open the exact plugin view with its route/type context attached.
						</div>
					</div>
					<RefreshButton loading={loading} onClick={() => void fetchViews()} />
				</div>

				<div
					style={{
						display: "grid",
						gridTemplateColumns: "minmax(220px, 1fr) auto",
						gap: 12,
						alignItems: "center",
						marginTop: 18,
					}}
				>
					<label style={{ position: "relative", minWidth: 0 }}>
						<span style={{ position: "absolute", opacity: 0 }}>
							Search views
						</span>
						<Search
							size={16}
							aria-hidden="true"
							style={{
								position: "absolute",
								left: 12,
								top: "50%",
								transform: "translateY(-50%)",
								color: viewManagerTheme.muted,
								pointerEvents: "none",
							}}
						/>
						<input
							ref={searchRef}
							type="search"
							value={searchQuery}
							onChange={(event) => setSearchQuery(event.target.value)}
							placeholder="Search views, plugins, routes..."
							{...searchAgentProps}
							style={{
								width: "100%",
								height: 40,
								boxSizing: "border-box",
								border: `1px solid ${viewManagerTheme.border}`,
								borderRadius: 8,
								background: viewManagerTheme.surface,
								color: viewManagerTheme.foreground,
								padding: searchQuery ? "0 40px 0 38px" : "0 12px 0 38px",
								fontSize: 13,
								outline: "none",
							}}
						/>
						{searchQuery && (
							<button
								type="button"
								aria-label="Clear view search"
								onClick={() => setSearchQuery("")}
								style={{
									position: "absolute",
									right: 6,
									top: "50%",
									transform: "translateY(-50%)",
									width: 28,
									height: 28,
									border: "none",
									borderRadius: 6,
									background: "transparent",
									color: viewManagerTheme.muted,
									cursor: "pointer",
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
								}}
							>
								<X size={15} aria-hidden="true" />
							</button>
						)}
					</label>
					<div
						style={{
							display: "flex",
							flexWrap: "wrap",
							justifyContent: "flex-end",
							gap: 6,
						}}
					>
						<ViewBadge>{views.length} TOTAL</ViewBadge>
						<ViewBadge>{readyCount} READY</ViewBadge>
						<ViewBadge>{typeCounts.gui} GUI</ViewBadge>
						<ViewBadge>{typeCounts.tui} TUI</ViewBadge>
						{typeCounts.xr > 0 && <ViewBadge>{typeCounts.xr} XR</ViewBadge>}
					</div>
				</div>
			</div>

			{/* Body */}
			<div style={{ padding: "24px" }}>
				{loading && (
					<div
						style={{
							textAlign: "center",
							padding: "48px 0",
							color: viewManagerTheme.muted,
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

				{!loading &&
					!error &&
					views.length > 0 &&
					filteredViews.length === 0 && (
						<SearchEmptyState query={trimmedSearchQuery} />
					)}

				{!loading && !error && views.length > 0 && filteredViews.length > 0 && (
					<div style={{ display: "grid", gap: 22 }}>
						{groupedViews.map((section) => (
							<section key={section.key} style={{ display: "grid", gap: 10 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "space-between",
										gap: 12,
									}}
								>
									<h2
										style={{
											margin: 0,
											fontSize: 13,
											fontWeight: 700,
											color: viewManagerTheme.foreground,
										}}
									>
										{section.label}
									</h2>
									<span
										style={{
											fontSize: 11,
											color: viewManagerTheme.muted,
										}}
									>
										{section.views.length}
									</span>
								</div>
								<div
									style={{
										display: "grid",
										gridTemplateColumns:
											"repeat(auto-fill, minmax(260px, 1fr))",
										gap: 12,
									}}
								>
									{section.views.map((view) => (
										<ViewCard
											key={`${view.viewType ?? "gui"}:${view.id}`}
											view={view}
											onOpen={openView}
										/>
									))}
								</div>
							</section>
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
				color: view.available
					? viewManagerTheme.accent
					: viewManagerTheme.danger,
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
				color: viewManagerTheme.success,
				border: `1px solid ${viewManagerTheme.borderAccent}`,
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
				borderTop:
					index === 0 ? "none" : `1px solid ${viewManagerTheme.borderAccent}`,
			}}
		>
			<span style={{ color: viewManagerTheme.muted }}>
				{String(index + 1).padStart(2, "0")}
			</span>
			<span style={{ color: viewManagerTheme.foreground, fontWeight: 700 }}>
				{view.label}
			</span>
			<span style={{ color: viewManagerTheme.success }}>
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
				style={{
					gridColumn: "2 / 5",
					color: viewManagerTheme.muted,
					fontSize: 12,
				}}
			>
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
					color: viewManagerTheme.accent,
					border: `1px solid ${viewManagerTheme.borderAccent}`,
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
				background: viewManagerTheme.background,
				color: viewManagerTheme.foreground,
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
				style={{ color: viewManagerTheme.muted, marginBottom: 16 }}
			>
				{loading ? "loading" : `${views.length} entries`} | {lastAction}
			</div>

			<div
				style={{
					border: `1px solid ${viewManagerTheme.borderAccent}`,
					borderRadius: 6,
					padding: 16,
					boxShadow: `inset 0 0 0 1px ${viewManagerTheme.shadowInset}`,
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
					<strong style={{ color: viewManagerTheme.foreground }}>
						registered tui views
					</strong>
					<TuiRefreshButton
						loading={loading}
						onClick={() => void fetchViews()}
					/>
				</div>

				{error && <div style={{ color: viewManagerTheme.danger }}>{error}</div>}
				{!error && views.length === 0 && !loading && (
					<div style={{ color: viewManagerTheme.muted }}>
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
