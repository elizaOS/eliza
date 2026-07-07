/**
 * ViewManagerSpatialView — the registered-views list authored with the spatial
 * vocabulary and mounted in `<SpatialSurface>` for the GUI surface.
 *
 * It is purely presentational (a snapshot + an open callback in, primitives out)
 * and imports only the cross-modality primitives plus the pure `ViewEntry`
 * helpers (no shell-host UI import). The collapse-by-id + modality-chip logic is
 * pure over the snapshot.
 */

import {
	Button,
	Card,
	Divider,
	HStack,
	Image,
	List,
	type SpatialTone,
	Text,
	VStack,
} from "@elizaos/ui/spatial";
import {
	collapseViewEntries,
	type ViewEntry,
	type ViewModality,
} from "../views/viewManagerData.ts";

export interface ViewManagerSnapshot {
	views: ViewEntry[];
	loading?: boolean;
	error?: string | null;
}

/** The surfaces this logical view renders on, ordered gui · xr · tui. */
function viewModalities(view: ViewEntry): ViewModality[] {
	return view.modalities ?? [view.viewType ?? "gui"];
}

function modalityTone(modality: ViewModality): SpatialTone {
	switch (modality) {
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
	/** Open a listed view (GUI press / terminal dispatch by `open:<id>`). */
	onOpenView?: (view: ViewEntry) => void;
}

export function ViewManagerSpatialView({
	snapshot,
	onOpenView,
}: ViewManagerSpatialViewProps) {
	// One row per logical view id, carrying the union of its surfaces — collapses
	// duplicate gui/xr/tui declarations of the same view into a single row with
	// modality chips, instead of one duplicate row per surface.
	const views = collapseViewEntries(snapshot.views);
	const available = views.filter((view) => view.available).length;
	return (
		<Card gap={1} padding={1}>
			<HStack gap={1} align="center">
				<Text style="caption" tone="success" grow={1}>
					{snapshot.loading ? "loading" : `${available}/${views.length} ready`}
				</Text>
				<Text style="caption" tone="muted">
					views
				</Text>
			</HStack>

			{snapshot.error ? (
				<Text tone="danger" style="caption">
					{snapshot.error}
				</Text>
			) : null}

			<Divider label="views" />
			{views.length === 0 ? (
				<Text tone="muted" align="center" style="caption">
					None
				</Text>
			) : (
				<List gap={1}>
					{views.slice(0, 12).map((view) => (
						<HStack
							key={view.id}
							gap={1}
							align="center"
							agent={`open-${view.id}`}
						>
							{view.heroImageUrl ? (
								<Image src={view.heroImageUrl} alt="" width={4} height={4} />
							) : null}
							<VStack gap={0} grow={1}>
								<Text bold wrap={false}>
									{view.label}
								</Text>
								<Text style="caption" tone="muted" wrap={false}>
									{view.path ?? view.pluginName}
								</Text>
								{/* Surface chips (gui/xr/tui) + per-view open/available
								    state, kept on one wrapped line so it never competes
								    horizontally with the open control on narrow terminals. */}
								<HStack gap={1} wrap align="center">
									{viewModalities(view).map((modality) => (
										<Text
											key={modality}
											style="caption"
											tone={modalityTone(modality)}
										>
											{modality}
										</Text>
									))}
									<Text
										style="caption"
										tone={view.available ? "success" : "danger"}
									>
										{view.available ? "ready" : "missing"}
									</Text>
								</HStack>
							</VStack>
							<Button
								variant="ghost"
								tone="default"
								agent={`open:${view.id}`}
								onPress={() => onOpenView?.(view)}
							>
								Open
							</Button>
						</HStack>
					))}
				</List>
			)}
		</Card>
	);
}

export default ViewManagerSpatialView;
