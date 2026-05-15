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

import { LayoutGrid, PackageOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ViewEntry {
	id: string;
	label: string;
	description?: string;
	icon?: string;
	path?: string;
	order?: number;
	available: boolean;
	bundleUrl?: string;
	heroImageUrl?: string;
	pluginName: string;
}

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

// ─── Main component ──────────────────────────────────────────────────────────

export function ViewManagerView() {
	const [views, setViews] = useState<ViewEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const fetchViews = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch("/api/views");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { views: ViewEntry[] };
			setViews(data.views ?? []);
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
				<button
					type="button"
					onClick={() => void fetchViews()}
					disabled={loading}
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
