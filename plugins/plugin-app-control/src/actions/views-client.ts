/**
 * @module plugin-app-control/actions/views-client
 * @description HTTP client for the `/api/views/*` routes.
 *
 * Mirrors the structure of `client/api.ts` but scoped to the view registry
 * endpoints. Kept as a separate module so the views action does not import
 * the full AppControlClient (different concern, different surface).
 */

import { createHash } from "node:crypto";
import type {
	Memory,
	ViewCapability,
	ViewCapabilityParameter,
	ViewType,
} from "@elizaos/core";
import { resolveServerOnlyPort } from "@elizaos/core";
import { createViewsRequestHeaders } from "./views-request-auth.js";

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
	views?: string[];
	panes?: ViewPaneSummary[];
	layout?: string;
	placement?: string;
	/** Sub-section the view is focused on (Settings = its section id, e.g. "voice"). */
	subview?: string;
	/** ISO timestamp of the navigate that switched into this view. */
	switchedAt?: string;
	/** Who initiated the switch — the agent (default) or the user clicking the UI. */
	source?: "agent" | "user";
	/** Server-computed: true only briefly after a switch (turn-scoped signal). */
	justSwitched?: boolean;
	updatedAt: string;
}

export interface ViewPaneSummary {
	viewId: string;
	viewType: ViewType;
}

export interface ViewNavigationReceipt {
	accepted: true;
	delivery: "client-owned" | "delivered" | "pending";
	revision: number;
	operationId?: string;
	operationRevision?: number;
	deliveryOwner?: "outbox";
	acknowledged?: true;
}

/** Active shell state plus the server-owned navigation revision. */
export interface CurrentViewSnapshot {
	currentView: CurrentViewSummary | null;
	revision: number;
}

function getApiBase(): string {
	const port = resolveServerOnlyPort(process.env);
	return `http://127.0.0.1:${port}`;
}

export function readViewClientId(
	message: Pick<Memory, "metadata">,
): string | undefined {
	const clientId = message.metadata?.clientId;
	return typeof clientId === "string" && clientId.trim()
		? clientId.trim()
		: undefined;
}

function viewRequestHeaders(clientId?: string): Record<string, string> {
	return {
		...createViewsRequestHeaders(),
		...(clientId ? { "X-ElizaOS-Client-Id": clientId } : {}),
	};
}

function isObject(v: unknown): v is Record<string, unknown> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

function canonicalJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.filter((key) => record[key] !== undefined)
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
		.join(",")}}`;
}

function createViewOperationId(
	operationScope: string,
	viewId: string,
	opts: Parameters<ViewsClient["navigate"]>[1],
): string {
	const descriptor = {
		operationScope,
		viewId,
		path: opts?.path,
		viewType: opts?.viewType,
		action: opts?.action,
		subview: opts?.subview,
		views: opts?.views,
		panes: opts?.panes,
		layout: opts?.layout,
		placement: opts?.placement,
		alwaysOnTop: opts?.alwaysOnTop,
		payload: opts?.payload,
	};
	const digest = createHash("sha256")
		.update(canonicalJson(descriptor))
		.digest("hex");
	return `views:${digest}`;
}

export type ParsedViewInteractionResponse =
	| {
			ok: true;
			success: boolean;
			body: Record<string, unknown>;
	  }
	| {
			ok: false;
			error: string;
	  };

export interface ViewInteractionReceipt {
	requestId?: string;
	revision?: number;
	entity?: {
		kind: "note" | "event";
		id: string;
	};
}

function readBoundedReceiptId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= 256 ? trimmed : undefined;
}

/** Extract a bounded mutation receipt without trusting arbitrary response data. */
export function readViewInteractionReceipt(
	result: unknown,
): ViewInteractionReceipt | undefined {
	if (!isObject(result)) return undefined;
	const capabilityResult = isObject(result.result) ? result.result : result;
	const state = isObject(capabilityResult.state)
		? capabilityResult.state
		: undefined;
	const data = isObject(capabilityResult.data)
		? capabilityResult.data
		: undefined;

	const requestId = readBoundedReceiptId(result.requestId);
	const revision =
		typeof state?.revision === "number" &&
		Number.isSafeInteger(state.revision) &&
		state.revision >= 0
			? state.revision
			: undefined;
	let entity: ViewInteractionReceipt["entity"];
	for (const kind of ["note", "event"] as const) {
		const candidate = isObject(data?.[kind]) ? data[kind] : undefined;
		const id = readBoundedReceiptId(candidate?.id);
		if (id) {
			entity = { kind, id };
			break;
		}
	}

	if (!requestId && revision === undefined && !entity) return undefined;
	return {
		...(requestId ? { requestId } : {}),
		...(revision !== undefined ? { revision } : {}),
		...(entity ? { entity } : {}),
	};
}

/**
 * Parse the successful HTTP response envelope returned by the view interaction
 * route. The route owns the authoritative success bit; a nested capability
 * failure can only narrow that result, never turn a failed wrapper into success.
 */
export async function parseViewInteractionResponse(
	response: Pick<Response, "json">,
): Promise<ParsedViewInteractionResponse> {
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		// error-policy:J3 malformed interaction JSON is an explicit invalid result.
		return { ok: false, error: "View interaction response was not valid JSON" };
	}

	if (!isObject(body)) {
		return { ok: false, error: "View interaction response was not an object" };
	}
	if (typeof body.success !== "boolean") {
		return {
			ok: false,
			error: "View interaction response was missing a boolean success field",
		};
	}

	let nestedSuccess: boolean | undefined;
	if (isObject(body.result) && Object.hasOwn(body.result, "success")) {
		if (typeof body.result.success !== "boolean") {
			return {
				ok: false,
				error: "View interaction result contained a non-boolean success field",
			};
		}
		nestedSuccess = body.result.success;
	}

	return { ok: true, success: body.success && nestedSuccess !== false, body };
}

type ViewCapabilityParams = NonNullable<ViewCapability["params"]>;

function parseCapabilityParameter(
	value: unknown,
	required: boolean | undefined,
): ViewCapabilityParameter | null {
	if (!isObject(value) || typeof value.type !== "string") return null;
	const enumValues = Array.isArray(value.enum)
		? value.enum.filter(
				(entry): entry is string | number | boolean =>
					typeof entry === "string" ||
					typeof entry === "number" ||
					typeof entry === "boolean",
			)
		: [];
	return {
		type: value.type,
		description: typeof value.description === "string" ? value.description : "",
		...(required === true ? { required: true } : {}),
		...(enumValues.length > 0 ? { enum: enumValues } : {}),
		...(typeof value.pattern === "string" ? { pattern: value.pattern } : {}),
		...(typeof value.minLength === "number" &&
		Number.isSafeInteger(value.minLength) &&
		value.minLength >= 0
			? { minLength: value.minLength }
			: {}),
		...(typeof value.maxLength === "number" &&
		Number.isSafeInteger(value.maxLength) &&
		value.maxLength >= 0
			? { maxLength: value.maxLength }
			: {}),
		...(typeof value.minimum === "number" && Number.isFinite(value.minimum)
			? { minimum: value.minimum }
			: {}),
		...(typeof value.maximum === "number" && Number.isFinite(value.maximum)
			? { maximum: value.maximum }
			: {}),
	};
}

function parseCapabilityParams(
	value: unknown,
): ViewCapabilityParams | undefined {
	if (!isObject(value)) return undefined;
	const params: ViewCapabilityParams = {};
	for (const [key, rawParam] of Object.entries(value)) {
		const parameter = parseCapabilityParameter(
			rawParam,
			isObject(rawParam) && rawParam.required === true,
		);
		if (parameter) params[key] = parameter;
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
		const parameter = parseCapabilityParameter(rawProperty, required.has(key));
		if (parameter) params[key] = parameter;
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

export function parseViewSummary(entry: Record<string, unknown>): ViewSummary {
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

function parseCurrentViewPanes(value: unknown): ViewPaneSummary[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
		throw new Error(
			"Malformed currentView.panes: expected 1 to 16 exact viewId/viewType pairs",
		);
	}
	const panes: ViewPaneSummary[] = [];
	const identities = new Set<string>();
	for (const rawPane of value) {
		if (!isObject(rawPane)) {
			throw new Error("Malformed currentView.panes: expected pane objects");
		}
		const viewId =
			typeof rawPane.viewId === "string" ? rawPane.viewId.trim() : "";
		const viewType = rawPane.viewType;
		if (
			!viewId ||
			!(viewType === "gui" || viewType === "tui" || viewType === "xr")
		) {
			throw new Error(
				"Malformed currentView.panes: expected exact viewId/viewType pairs",
			);
		}
		const identity = `${viewType}:${viewId}`;
		if (identities.has(identity)) {
			throw new Error("Malformed currentView.panes: duplicate pane identity");
		}
		identities.add(identity);
		panes.push({ viewId, viewType });
	}
	return panes;
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
	const views = Array.isArray(currentView.views)
		? currentView.views.filter(
				(view): view is string => typeof view === "string",
			)
		: undefined;
	const panes = Object.hasOwn(currentView, "panes")
		? parseCurrentViewPanes(currentView.panes)
		: undefined;
	const layout =
		typeof currentView.layout === "string" ? currentView.layout : undefined;
	const placement =
		typeof currentView.placement === "string"
			? currentView.placement
			: undefined;
	const switchedAt =
		typeof currentView.switchedAt === "string"
			? currentView.switchedAt
			: undefined;
	const subview =
		typeof currentView.subview === "string" && currentView.subview.length > 0
			? currentView.subview
			: undefined;
	const source =
		currentView.source === "agent" || currentView.source === "user"
			? currentView.source
			: undefined;
	// `justSwitched` is computed server-side and lives at the top level of the
	// response, not inside `currentView` — surface it on the summary for callers.
	const justSwitched = body.justSwitched === true;
	return {
		viewId,
		viewPath,
		viewLabel,
		viewType,
		action,
		views,
		panes,
		layout,
		placement,
		subview,
		switchedAt,
		source,
		justSwitched,
		updatedAt,
	};
}

function parseCurrentViewSnapshot(body: unknown): CurrentViewSnapshot {
	if (!isObject(body)) {
		throw new Error("Malformed /api/views/current response: expected object");
	}
	const revision = body.revision;
	if (
		typeof revision !== "number" ||
		!Number.isSafeInteger(revision) ||
		revision < 0
	) {
		throw new Error("Malformed /api/views/current response: missing revision");
	}
	return { currentView: parseCurrentView(body), revision };
}

/** Read the active view and revision required for conditional navigation. */
export async function getCurrentViewSnapshot(
	clientId?: string,
): Promise<CurrentViewSnapshot> {
	const response = await fetch(`${getApiBase()}/api/views/current`, {
		method: "GET",
		headers: viewRequestHeaders(clientId),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`Failed to get current view: HTTP ${response.status}`);
	}
	const body: unknown = await response.json();
	return parseCurrentViewSnapshot(body);
}

export interface ViewsClient {
	listViews(opts?: {
		developerMode?: boolean;
		viewType?: ViewType;
	}): Promise<ViewSummary[]>;
	getCurrentView(): Promise<CurrentViewSummary | null>;
	/**
	 * Navigate the active shell to a view. Shared by the VIEWS action's show
	 * handler and the contextual view evaluator so both go through one loopback
	 * seam (`POST /api/views/:id/navigate`). Returns true when the shell
	 * accepted the conditional request. Non-2xx and malformed responses reject;
	 * callers must never claim navigation when the shell did not accept it.
	 */
	navigate(
		viewId: string,
		opts?: {
			path?: string;
			viewType?: ViewType;
			expectedRevision?: number;
			subview?: string;
			action?: string;
			views?: string[];
			panes?: ViewPaneSummary[];
			layout?: string;
			placement?: string;
			alwaysOnTop?: boolean;
			payload?: unknown;
		},
	): Promise<ViewNavigationReceipt>;
}

export function createViewsClient(
	options: { clientId?: string; navigationOperationScope?: string } = {},
): ViewsClient {
	const { clientId, navigationOperationScope } = options;
	let observedRevision: number | undefined;
	return {
		async listViews(opts = {}) {
			const params = new URLSearchParams();
			if (opts.developerMode) params.set("developerMode", "true");
			if (opts.viewType) params.set("viewType", opts.viewType);
			const qs = params.size > 0 ? `?${params.toString()}` : "";
			const url = `${getApiBase()}/api/views${qs}`;
			const response = await fetch(url, {
				method: "GET",
				headers: viewRequestHeaders(clientId),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			});
			if (!response.ok) {
				throw new Error(`Failed to list views: HTTP ${response.status}`);
			}
			const body: unknown = await response.json();
			return parseViewList(body);
		},

		async getCurrentView() {
			const snapshot = await getCurrentViewSnapshot(clientId);
			observedRevision = snapshot.revision;
			return snapshot.currentView;
		},

		async navigate(viewId, opts = {}) {
			const operationId = navigationOperationScope
				? createViewOperationId(navigationOperationScope, viewId, opts)
				: undefined;
			const expectedRevision =
				opts.expectedRevision ??
				observedRevision ??
				(await getCurrentViewSnapshot(clientId)).revision;
			observedRevision = undefined;
			const viewTypeQuery = opts.viewType
				? `?viewType=${encodeURIComponent(opts.viewType)}`
				: "";
			const response = await fetch(
				`${getApiBase()}/api/views/${encodeURIComponent(viewId)}/navigate${viewTypeQuery}`,
				{
					method: "POST",
					headers: viewRequestHeaders(clientId),
					body: JSON.stringify({
						...(operationId ? { operationId, deliveryOwner: "outbox" } : {}),
						expectedRevision,
						path: opts.path,
						action: opts.action,
						viewType: opts.viewType,
						subview: opts.subview,
						views: opts.views,
						panes: opts.panes,
						layout: opts.layout,
						placement: opts.placement,
						alwaysOnTop: opts.alwaysOnTop,
						payload: opts.payload,
						...(clientId ? { clientId } : {}),
					}),
					signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
				},
			);
			if (!response.ok) {
				throw new Error(`Failed to navigate view: HTTP ${response.status}`);
			}
			let result: unknown;
			try {
				result = await response.json();
			} catch (cause) {
				// error-policy:J2 preserve the transport parse failure for the action boundary.
				throw new Error("Malformed view navigation response: invalid JSON", {
					cause,
				});
			}
			if (!isObject(result) || result.ok !== true || result.accepted !== true) {
				throw new Error("Malformed view navigation response: not accepted");
			}
			const delivery = result.delivery;
			const revision = result.revision;
			const resultOperationId = result.operationId;
			const operationRevision = result.operationRevision;
			const resultDeliveryOwner = result.deliveryOwner;
			const acknowledged = result.acknowledged;
			if (
				(delivery !== "client-owned" &&
					delivery !== "delivered" &&
					delivery !== "pending") ||
				typeof revision !== "number" ||
				!Number.isSafeInteger(revision) ||
				revision < 0
			) {
				throw new Error("Malformed view navigation response: invalid receipt");
			}
			const hasOperationReceipt =
				resultDeliveryOwner === "outbox" &&
				typeof resultOperationId === "string" &&
				/^[A-Za-z0-9._:-]{1,128}$/.test(resultOperationId) &&
				typeof operationRevision === "number" &&
				Number.isSafeInteger(operationRevision) &&
				operationRevision > 0 &&
				revision > 0;
			if (
				(resultDeliveryOwner !== undefined ||
					resultOperationId !== undefined ||
					operationRevision !== undefined) &&
				!hasOperationReceipt
			) {
				throw new Error(
					"Malformed view navigation response: invalid operation",
				);
			}
			if (
				acknowledged !== undefined &&
				(acknowledged !== true || !hasOperationReceipt)
			) {
				throw new Error(
					"Malformed view navigation response: invalid acknowledgement",
				);
			}
			if (
				operationId &&
				(!hasOperationReceipt || resultOperationId !== operationId)
			) {
				throw new Error(
					"Malformed view navigation response: missing operation receipt",
				);
			}
			return {
				accepted: true,
				delivery,
				revision,
				...(hasOperationReceipt
					? {
							deliveryOwner: "outbox" as const,
							operationId: resultOperationId,
							operationRevision,
						}
					: {}),
				...(acknowledged === true ? { acknowledged: true as const } : {}),
			};
		},
	};
}
