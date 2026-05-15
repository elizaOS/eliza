/**
 * @module plugin-app-control/actions/views-client
 * @description HTTP client for the `/api/views/*` routes.
 *
 * Mirrors the structure of `client/api.ts` but scoped to the view registry
 * endpoints. Kept as a separate module so the views action does not import
 * the full AppControlClient (different concern, different surface).
 */

import { resolveServerOnlyPort } from "@elizaos/core";
import type { ViewCapability } from "@elizaos/core";

const REQUEST_TIMEOUT_MS = 10_000;

/** Wire shape returned by GET /api/views (subset we consume). */
export interface ViewSummary {
	id: string;
	label: string;
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

function getApiBase(): string {
	const port = resolveServerOnlyPort(process.env);
	return `http://127.0.0.1:${port}`;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
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
		? (entry.capabilities.filter(isObject) as unknown as ViewCapability[])
		: undefined;

	return {
		id,
		label,
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

export interface ViewsClient {
	listViews(opts?: { developerMode?: boolean }): Promise<ViewSummary[]>;
}

export function createViewsClient(): ViewsClient {
	return {
		async listViews(opts = {}) {
			const qs = opts.developerMode ? "?developerMode=true" : "";
			const url = `${getApiBase()}/api/views${qs}`;
			const response = await fetch(url, {
				method: "GET",
				headers: { "Content-Type": "application/json" },
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(
					`Failed to list views: HTTP ${response.status}`,
				);
			}
			const body: unknown = await response.json();
			return parseViewList(body);
		},
	};
}
