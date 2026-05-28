/**
 * @module plugin-app-control/actions/views-client
 * @description HTTP client for the `/api/views/*` routes.
 *
 * Mirrors the structure of `client/api.ts` but scoped to the view registry
 * endpoints. Kept as a separate module so the views action does not import
 * the full AppControlClient (different concern, different surface).
 */
import { resolveServerOnlyPort } from "@elizaos/core";
const REQUEST_TIMEOUT_MS = 10_000;
function getApiBase() {
	const port = resolveServerOnlyPort(process.env);
	return `http://127.0.0.1:${port}`;
}
function isObject(v) {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}
function parseViewSummary(entry) {
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
		entry.viewType === "gui" || entry.viewType === "tui"
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
		? entry.tags.filter((t) => typeof t === "string")
		: undefined;
	const capabilities = Array.isArray(entry.capabilities)
		? entry.capabilities.filter(isObject)
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
function parseViewList(body) {
	if (!isObject(body)) {
		throw new Error("Malformed /api/views response: expected object");
	}
	const views = body.views;
	if (!Array.isArray(views)) {
		throw new Error("Malformed /api/views response: missing views array");
	}
	return views.filter(isObject).map(parseViewSummary);
}
function parseCurrentView(body) {
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
		!(viewType === "gui" || viewType === "tui") ||
		typeof updatedAt !== "string"
	) {
		throw new Error("Malformed currentView: missing required fields");
	}
	const action =
		typeof currentView.action === "string" ? currentView.action : undefined;
	return { viewId, viewPath, viewLabel, viewType, action, updatedAt };
}
export function createViewsClient() {
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
			const body = await response.json();
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
			const body = await response.json();
			return parseCurrentView(body);
		},
	};
}
//# sourceMappingURL=views-client.js.map
