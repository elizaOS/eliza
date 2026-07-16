/**
 * View manager presentation authored with the spatial vocabulary. The shipped
 * route is GUI-only today, but the view keeps the modality-chip and primitive
 * boundaries so future adapters can reuse the same snapshot contract.
 *
 * It is purely presentational (a snapshot + an open callback in, primitives out)
 * and imports only cross-modality primitives plus the pure `ViewEntry` helpers.
 * The collapse-by-id + modality-chip logic is pure over the snapshot.
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
	openingViewId?: string | null;
}

/** The surfaces this logical view can render on, ordered gui · xr · tui. */
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
	/** Open a listed view from a rendered control or future adapter dispatch. */
	onOpenView?: (view: ViewEntry) => void;
}

export function ViewManagerSpatialView({
	snapshot,
	onOpenView,
}: ViewManagerSpatialViewProps) {
	// One row per logical view id, carrying the union of its surfaces, so future
	// modality declarations cannot duplicate the base GUI row.
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
			{views.length === 0 && !snapshot.loading && !snapshot.error ? (
				<Text tone="muted" align="center" style="caption">
					None
				</Text>
			) : views.length > 0 ? (
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
								{/* Surface chips plus per-view open/available state stay on
								    one wrapped line so the open control remains readable. */}
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
								disabled={
									snapshot.openingViewId !== null &&
									snapshot.openingViewId !== undefined
								}
								onPress={() => onOpenView?.(view)}
							>
								{snapshot.openingViewId === view.id ? "Opening…" : "Open"}
							</Button>
						</HStack>
					))}
				</List>
			) : null}
		</Card>
	);
}

export default ViewManagerSpatialView;
