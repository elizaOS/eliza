/**
 * React-free data layer for the View Manager bundle. Read requests use the
 * browser fetch surface, while mutations go through the shell's authenticated
 * API transport so cookie sessions and native hosts share one security path.
 */

import { ElizaError } from "@elizaos/core";
import { fetchWithCsrf } from "@elizaos/ui/api/csrf-client";

/**
 * A surface a view renders on. Mirrors `ViewModality` in `@elizaos/core`; kept
 * local so this bundle (built against core's published dist) doesn't depend on a
 * just-landed core export being present in that dist.
 */
export type ViewModality = "gui" | "tui" | "xr";

const MODALITY_ORDER: readonly ViewModality[] = ["gui", "xr", "tui"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isViewModality(value: unknown): value is ViewModality {
	return value === "gui" || value === "tui" || value === "xr";
}

function invalidViewListResponse(
	message: string,
	context: Record<string, unknown> = {},
	options: { cause?: unknown } = {},
): never {
	throw new ElizaError(message, {
		code: "VIEW_MANAGER_LIST_RESPONSE_INVALID",
		context,
		...(options.cause !== undefined ? { cause: options.cause } : {}),
	});
}

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
	 * same-id declarations so the manager lists the
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
 * the union of every surface they render on. The GUI entry is
 * preferred as the base (clean label, no surface suffix); first-seen order is
 * preserved. This is what makes a view appear ONCE with modality badges instead
 * of duplicate rows for future alternate modalities.
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
	return order.map((id) => {
		const entry = byId.get(id);
		if (!entry) {
			throw new ElizaError("Collapsed view entry is missing", {
				code: "VIEW_MANAGER_COLLAPSE_INVARIANT_FAILED",
				context: { viewId: id },
			});
		}
		return entry;
	});
}

function optionalString(
	record: Record<string, unknown>,
	key: string,
	index: number,
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		return invalidViewListResponse(
			`View entry ${index}.${key} must be a string`,
			{ index, field: key },
		);
	}
	return value;
}

function parseViewEntry(value: unknown, index: number): ViewEntry {
	if (!isRecord(value)) {
		return invalidViewListResponse(`View entry ${index} must be an object`, {
			index,
		});
	}
	const id = value.id;
	const label = value.label;
	const available = value.available;
	const pluginName = value.pluginName;
	if (typeof id !== "string" || id.trim().length === 0) {
		return invalidViewListResponse(
			`View entry ${index}.id must be a non-empty string`,
			{ index, field: "id" },
		);
	}
	if (typeof label !== "string" || label.trim().length === 0) {
		return invalidViewListResponse(
			`View entry ${index}.label must be a non-empty string`,
			{ index, field: "label" },
		);
	}
	if (typeof available !== "boolean") {
		return invalidViewListResponse(
			`View entry ${index}.available must be a boolean`,
			{ index, field: "available" },
		);
	}
	if (typeof pluginName !== "string" || pluginName.trim().length === 0) {
		return invalidViewListResponse(
			`View entry ${index}.pluginName must be a non-empty string`,
			{ index, field: "pluginName" },
		);
	}

	const viewType = value.viewType;
	if (viewType !== undefined && !isViewModality(viewType)) {
		return invalidViewListResponse(`View entry ${index}.viewType is invalid`, {
			index,
			field: "viewType",
			value: viewType,
		});
	}
	const rawModalities = value.modalities;
	let modalities: ViewModality[] | undefined;
	if (rawModalities !== undefined) {
		if (!Array.isArray(rawModalities) || !rawModalities.every(isViewModality)) {
			return invalidViewListResponse(
				`View entry ${index}.modalities must contain valid modalities`,
				{ index, field: "modalities" },
			);
		}
		modalities = dedupeModalities(rawModalities);
	}
	const order = value.order;
	if (
		order !== undefined &&
		(typeof order !== "number" || !Number.isFinite(order))
	) {
		return invalidViewListResponse(
			`View entry ${index}.order must be a finite number`,
			{ index, field: "order" },
		);
	}
	const description = optionalString(value, "description", index);
	const icon = optionalString(value, "icon", index);
	const viewPath = optionalString(value, "path", index);
	const bundleUrl = optionalString(value, "bundleUrl", index);
	const heroImageUrl = optionalString(value, "heroImageUrl", index);

	return {
		id,
		label,
		available,
		pluginName,
		...(viewType ? { viewType } : {}),
		...(modalities ? { modalities } : {}),
		...(description !== undefined ? { description } : {}),
		...(icon !== undefined ? { icon } : {}),
		...(viewPath !== undefined ? { path: viewPath } : {}),
		...(order !== undefined ? { order } : {}),
		...(bundleUrl !== undefined ? { bundleUrl } : {}),
		...(heroImageUrl !== undefined ? { heroImageUrl } : {}),
	};
}

export async function fetchViewEntries(
	viewType?: "gui" | "tui" | "xr",
): Promise<ViewEntry[]> {
	const qs = viewType ? `?viewType=${viewType}` : "";
	const res = await fetch(`/api/views${qs}`);
	if (!res.ok) {
		throw new ElizaError(`GET /api/views returned HTTP ${res.status}`, {
			code: "VIEW_MANAGER_LIST_HTTP_FAILED",
			context: { status: res.status, viewType },
		});
	}
	let data: unknown;
	try {
		data = await res.json();
	} catch (cause) {
		// error-policy:J2 preserve the JSON parser failure while adding the API
		// boundary and response status needed to diagnose a broken registry payload.
		return invalidViewListResponse(
			"GET /api/views returned malformed JSON",
			{ status: res.status, viewType },
			{ cause },
		);
	}
	if (!isRecord(data) || !Array.isArray(data.views)) {
		return invalidViewListResponse(
			"GET /api/views response must contain a views array",
			{ status: res.status, viewType },
		);
	}
	return data.views.map(parseViewEntry);
}

export async function requestViewNavigation(
	view: Pick<ViewEntry, "id" | "path" | "viewType">,
	options: { source?: "agent" | "user" } = {},
): Promise<void> {
	const response = await fetchWithCsrf(
		`/api/views/${encodeURIComponent(view.id)}/navigate${
			view.viewType ? `?viewType=${view.viewType}` : ""
		}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: view.path,
				viewType: view.viewType,
				...(options.source ? { source: options.source } : {}),
			}),
		},
	);
	if (!response.ok) {
		throw new ElizaError(`Could not open view: HTTP ${response.status}`, {
			code: "VIEW_MANAGER_NAVIGATION_HTTP_FAILED",
			context: { status: response.status, viewId: view.id },
		});
	}
}

export async function interact(
	capability: string,
	params?: Record<string, unknown>,
): Promise<unknown> {
	if (capability === "list-views") {
		return { views: await fetchViewEntries() };
	}
	if (capability === "open-view") {
		const viewId = typeof params?.viewId === "string" ? params.viewId : null;
		if (!viewId) {
			throw new ElizaError("viewId is required", {
				code: "VIEW_MANAGER_VIEW_ID_REQUIRED",
				context: { capability },
			});
		}
		const views = await fetchViewEntries();
		const view = views.find((entry) => entry.id === viewId);
		if (!view) {
			throw new ElizaError(`View "${viewId}" not found`, {
				code: "VIEW_MANAGER_VIEW_NOT_FOUND",
				context: { viewId },
			});
		}
		await requestViewNavigation(view);
		return { opened: true, viewId, viewType: view.viewType ?? "gui" };
	}
	throw new ElizaError(`Unsupported capability "${capability}"`, {
		code: "VIEW_MANAGER_CAPABILITY_UNSUPPORTED",
		context: { capability },
	});
}
