/**
 * ViewManagerSpatialView — the registered-views list authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus a type-only view of
 * the `ViewEntry` shape, so it is safe to render in the Node agent process where
 * the terminal lives (no shell-host UI import).
 */

import {
	Card,
	Divider,
	HStack,
	Image,
	List,
	type SpatialTone,
	Text,
	VStack,
} from "@elizaos/ui/spatial";
import type { ViewEntry } from "../views/viewManagerData.ts";

export interface ViewManagerSnapshot {
	views: ViewEntry[];
	loading?: boolean;
	error?: string | null;
}

function viewTypeTone(viewType: ViewEntry["viewType"]): SpatialTone {
	switch (viewType) {
		case "tui":
			return "warning";
		case "xr":
			return "primary";
		default:
			return "muted";
	}
}

export interface ViewManagerSpatialViewProps {
	snapshot: ViewManagerSnapshot;
}

export function ViewManagerSpatialView({
	snapshot,
}: ViewManagerSpatialViewProps) {
	const available = snapshot.views.filter((view) => view.available).length;
	return (
		<Card title="Views" gap={1} padding={1}>
			<HStack gap={1} align="center">
				<Text style="caption" tone="success" grow={1}>
					{snapshot.loading
						? "loading"
						: `${available}/${snapshot.views.length} ready`}
				</Text>
				<Text style="caption" tone="muted">
					registered views
				</Text>
			</HStack>

			{snapshot.error ? (
				<Text tone="danger" style="caption">
					{snapshot.error}
				</Text>
			) : null}

			<Divider label="views" />
			{snapshot.views.length === 0 ? (
				<Text tone="muted" align="center" style="caption">
					No views registered
				</Text>
			) : (
				<List gap={1}>
					{snapshot.views.slice(0, 12).map((view) => (
						<HStack
							key={`${view.viewType ?? "gui"}:${view.id}`}
							gap={1}
							align="center"
							agent={`open-${view.id}`}
						>
							{view.heroImageUrl ? (
								<Image src={view.heroImageUrl} alt="" width={4} height={4} />
							) : (
								<Text tone={viewTypeTone(view.viewType)}>
									[{view.viewType ?? "gui"}]
								</Text>
							)}
							<VStack gap={0} grow={1}>
								<Text bold wrap={false}>
									{view.label}
								</Text>
								<Text style="caption" tone="muted" wrap={false}>
									{view.path ?? view.pluginName}
								</Text>
							</VStack>
							<Text
								style="caption"
								tone={view.available ? "success" : "danger"}
							>
								{view.available ? "ready" : "missing"}
							</Text>
						</HStack>
					))}
				</List>
			)}
		</Card>
	);
}

export default ViewManagerSpatialView;
