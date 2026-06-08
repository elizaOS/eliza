/**
 * @module plugin-app-control/actions/views-client
 * @description HTTP client for the `/api/views/*` routes.
 *
 * Mirrors the structure of `client/api.ts` but scoped to the view registry
 * endpoints. Kept as a separate module so the views action does not import
 * the full AppControlClient (different concern, different surface).
 */

import type { ViewCapability, ViewType } from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/core";

const REQUEST_TIMEOUT_MS = 10_000;

/** Wire shape returned by GET /api/views (subset we consume). */
export interface ViewSummary {
	id: string;
	label: string;
	viewType?: ViewType;
	description?: string;
	icon?: string;
	path?: string;
	order?: number;
	tags?: string[];
	pluginName: string;
	bundleUrl?: string;
	heroImageUrl?: string;
	available: boolean;
	capabilities?: ViewCapability[];
	visibleInManager?: boolean;
	developerOnly?: boolean;
}

export interface CurrentViewSummary {
	viewId: string;
	viewPath: string | null;
	viewLabel: string;
	viewType: ViewType;
	action?: string;
	updatedAt: string;
}

function getApiBase(): string {
	const port = resolveServerOnlyPort(process.env);
	return `http://127.0.0.1:${port}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

type ViewCapabilityParams = NonNullable<ViewCapability["params"]>;

function parseCapabilityParams(
	value: unknown,
): ViewCapabilityParams | undefined {
	if (!isObject(value)) return undefined;
	const params: ViewCapabilityParams = {};
	for (const [key, rawParam] of Object.entries(value)) {
		if (!isObject(rawParam) || typeof rawParam.type !== "string") continue;
		params[key] = {
			type: rawParam.type,
			description:
				typeof rawParam.description === "string" ? rawParam.description : "",
			...(typeof rawParam.required === "boolean"
				? { required: rawParam.required }
				: {}),
		};
	}
	return Object.keys(params).length > 0 ? params : undefined;
}

function parseJsonSchemaParams(
	value: unknown,
): ViewCapabilityParams | undefined {
	if (!isObject(value) || !isObject(value.properties)) return undefined;
	const required = Array.isArray(value.required)
		? new Set(
				value.required.filter(
					(item): item is string => typeof item === "string",
				),
			)
		: new Set<string>();
	const params: ViewCapabilityParams = {};
	for (const [key, rawProperty] of Object.entries(value.properties)) {
		if (!isObject(rawProperty) || typeof rawProperty.type !== "string")
			continue;
		params[key] = {
			type: rawProperty.type,
			description:
				typeof rawProperty.description === "string"
					? rawProperty.description
					: "",
			...(required.has(key) ? { required: true } : {}),
		};
	}
	return Object.keys(params).length > 0 ? params : undefined;
}

function parseViewCapability(entry: unknown): ViewCapability | null {
	if (!isObject(entry)) return null;
	const rawId = typeof entry.id === "string" ? entry.id : entry.name;
	if (typeof rawId !== "string" || rawId.trim().length === 0) return null;
	const params =
		parseCapabilityParams(entry.params) ??
		parseJsonSchemaParams(entry.inputSchema);
	return {
		id: rawId.trim(),
		description: typeof entry.description === "string" ? entry.description : "",
		...(params ? { params } : {}),
	};
}

function parseViewSummary(entry: Record<string, unknown>): ViewSummary {
	const id = entry.id;
	const label = entry.label;
	const pluginName = entry.pluginName;
	const available = entry.available;

	if (
		typeof id !== "string" ||
		typeof label !== "string" ||
		typeof pluginName !== "string" ||
		typeof available !== "boolean"
	) {
		throw new Error("Malformed view entry: missing required fields");
	}

	const description =
		typeof entry.description === "string" ? entry.description : undefined;
	const icon = typeof entry.icon === "string" ? entry.icon : undefined;
	const path = typeof entry.path === "string" ? entry.path : undefined;
	const viewType =
		entry.viewType === "gui" ||
		entry.viewType === "tui" ||
		entry.viewType === "xr"
			? entry.viewType
			: undefined;
	const order = typeof entry.order === "number" ? entry.order : undefined;
	const bundleUrl =
		typeof entry.bundleUrl === "string" ? entry.bundleUrl : undefined;
	const heroImageUrl =
		typeof entry.heroImageUrl === "string" ? entry.heroImageUrl : undefined;
	const visibleInManager =
		typeof entry.visibleInManager === "boolean"
			? entry.visibleInManager
			: undefined;
	const developerOnly =
		typeof entry.developerOnly === "boolean" ? entry.developerOnly : undefined;

	const tags = Array.isArray(entry.tags)
		? entry.tags.filter((t): t is string => typeof t === "string")
		: undefined;

	const capabilities = Array.isArray(entry.capabilities)
		? entry.capabilities
				.map(parseViewCapability)
				.filter(
					(capability): capability is ViewCapability => capability !== null,
				)
		: undefined;

	return {
		id,
		label,
		viewType,
		description,
		icon,
		path,
		order,
		tags,
		pluginName,
		bundleUrl,
		heroImageUrl,
		available,
		capabilities,
		visibleInManager,
		developerOnly,
	};
}

function parseViewList(body: unknown): ViewSummary[] {
	if (!isObject(body)) {
		throw new Error("Malformed /api/views response: expected object");
	}
	const views = (body as Record<string, unknown>).views;
	if (!Array.isArray(views)) {
		throw new Error("Malformed /api/views response: missing views array");
	}
	return views.filter(isObject).map(parseViewSummary);
}

function parseCurrentView(body: unknown): CurrentViewSummary | null {
	if (!isObject(body)) {
		throw new Error("Malformed /api/views/current response: expected object");
	}
	const currentView = body.currentView;
	if (currentView === null || currentView === undefined) return null;
	if (!isObject(currentView)) {
		throw new Error("Malformed currentView: expected object or null");
	}
	const viewId = currentView.viewId;
	const viewPath = currentView.viewPath;
	const viewLabel = currentView.viewLabel;
	const viewType = currentView.viewType;
	const updatedAt = currentView.updatedAt;
	if (
		typeof viewId !== "string" ||
		!(typeof viewPath === "string" || viewPath === null) ||
		typeof viewLabel !== "string" ||
		!(viewType === "gui" || viewType === "tui" || viewType === "xr") ||
		typeof updatedAt !== "string"
	) {
		throw new Error("Malformed currentView: missing required fields");
	}
	const action =
		typeof currentView.action === "string" ? currentView.action : undefined;
	return { viewId, viewPath, viewLabel, viewType, action, updatedAt };
}

export interface ViewsClient {
	listViews(opts?: {
		developerMode?: boolean;
		viewType?: ViewType;
	}): Promise<ViewSummary[]>;
	getCurrentView(): Promise<CurrentViewSummary | null>;
}

export function createViewsClient(): ViewsClient {
	return {
		async listViews(opts = {}) {
			const params = new URLSearchParams();
			if (opts.developerMode) params.set("developerMode", "true");
			if (opts.viewType) params.set("viewType", opts.viewType);
			const qs = params.size > 0 ? `?${params.toString()}` : "";
			const url = `${getApiBase()}/api/views${qs}`;
			const response = await fetch(url, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`Failed to list views: HTTP ${response.status}`);
			}
			const body: unknown = await response.json();
			return parseViewList(body);
		},

		async getCurrentView() {
			const response = await fetch(`${getApiBase()}/api/views/current`, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`Failed to get current view: HTTP ${response.status}`);
			}
			const body: unknown = await response.json();
			return parseCurrentView(body);
		},
	};
}
