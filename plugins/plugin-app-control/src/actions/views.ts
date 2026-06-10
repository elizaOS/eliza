/**
 * @module plugin-app-control/actions/views
 *
 * Unified VIEWS action. Lets the Eliza agent list, open, search, manage,
 * create, edit, and delete UI views contributed by plugins via `Plugin.views`.
 *
 * Sub-modes dispatched from a single action keep the planner surface minimal
 * and the handler testable. Mirrors the APP action structure.
 */

import path from "node:path";
import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	ViewCapability,
	ViewType,
} from "@elizaos/core";
import { hasOwnerAccess as defaultOwnerAccessFn, logger } from "@elizaos/core";
import { normalizeActionOptions, readStringOption } from "../params.js";
import {
	createViewsClient,
	type ViewSummary,
	type ViewsClient,
} from "./views-client.js";
import {
	hasPendingViewsCreateIntent,
	isChoiceReply,
	runViewsCreate,
} from "./views-create.js";
import {
	hasPendingDeleteConfirm,
	isDeleteCancellation,
	isDeleteConfirmation,
	runViewsDelete,
} from "./views-delete.js";
import { runViewsEdit } from "./views-edit.js";
import { runViewsList } from "./views-list.js";
import { runViewsSearch, scoreView } from "./views-search.js";
import { runViewsShow } from "./views-show.js";

export type ViewsMode =
	| "list"
	| "current"
	| "show"
	| "open"
	| "close"
	| "search"
	| "manager"
	| "broadcast"
	| "interact"
	| "create"
	| "edit"
	| "delete"
	| "remove"
	| "pin"
	| "window"
	| "split"
	| "tile";

const MODES: readonly ViewsMode[] = [
	"list",
	"current",
	"show",
	"open",
	"close",
	"search",
	"manager",
	"broadcast",
	"interact",
	"create",
	"edit",
	"delete",
	"remove",
	"pin",
	"window",
	"split",
	"tile",
] as const;

const VIEW_ACTION_CONTEXTS = [
	"simple",
	"general",
	"memory",
	"documents",
	"knowledge",
	"research",
	"web",
	"browser",
	"code",
	"files",
	"terminal",
	"email",
	"calendar",
	"contacts",
	"tasks",
	"todos",
	"productivity",
	"health",
	"screen_time",
	"subscriptions",
	"finance",
	"payments",
	"wallet",
	"crypto",
	"messaging",
	"phone",
	"social",
	"social_posting",
	"media",
	"automation",
	"connectors",
	"settings",
	"character",
	"secrets",
	"admin",
	"state",
	"world",
	"game",
] as const;

// Intent regexes — order matters: more specific first.
const LIST_VERBS =
	/\b(list|show all|what views|all views|available views|which views)\b/i;
// NB: "open" is deliberately excluded here — "open <name> view" is a navigate
// (show) intent, not a "report the currently-open view" query. Phrasings like
// "which view is currently open" still match via the "current" keyword.
const CURRENT_VIEW_VERBS =
	/\b(current|active|selected)\b.{0,30}\bview\b|\bwhat(?:'s| is)?\b.{0,20}\bview\b/i;
const WHAT_VIEWS_VERB = /what.{0,20}views?\b/i;
const SEARCH_VERBS = /\b(search|find|look for|filter)\b.*\bview/i;
const MANAGER_VERBS =
	/\b(view manager|views manager|manage views|open manager|show manager)\b/i;
const SHOW_ALL_VIEWS_MANAGER =
	/\b(show|open|bring up|pull up)\b\s+(?:me\s+)?(?:all\s+)?(?:the\s+)?views\b/i;
const SHOW_APPS_VERBS =
	/\b(show|open|go to|navigate to)\b\s+(?:the\s+)?(?:apps?|app page|apps page)\b/i;
const CLOSE_VERBS =
	/\b(close|dismiss|hide|exit|quit)\b.{0,40}\b(view|app|panel|window)\b/i;
const CLOSE_ALL_VERBS =
	/\b(close|dismiss|hide|exit|quit)\b.{0,30}\ball\b.{0,30}\b(views?|apps?|panels?|windows?|tabs?)\b/i;
const CLOSE_PREFIX_VERBS = /^\s*(close|dismiss|hide|exit|quit)\b/i;
const SHOW_VERBS =
	/\b(show|open|navigate to|go to|switch to|launch|display|bring up|pull up)\b/i;
const VIEW_NOUN = /\bview[s]?\b/i;
const BROADCAST_VERBS =
	/\b(tell|notify|signal|broadcast|send.*event|emit|trigger|ping)\b.{0,60}\bview\b/i;
const INTERACT_VERBS =
	/\b(click|tap|press|focus|fill|interact|invoke|call|use capability)\b.{0,60}\b(view|button|input|field)\b/i;
const CREATE_VERBS =
	/\b(create|build|make|new|scaffold|generate|spin up)\b.{0,30}\b(view|plugin)\b/i;
const EDIT_VERBS_RE =
	/\b(edit|update|modify|change|fix|improve|rewrite)\b.{0,30}\b(view|plugin)\b/i;
const DELETE_VERBS_RE =
	/\b(delete|remove|uninstall|destroy|drop)\b.{0,30}\b(view|plugin)\b/i;
const PIN_VERBS =
	/\b(pin|pin as tab|add.*tab|pin.*desktop|keep.*tab|dock)\b.{0,40}\bview\b/i;
const WINDOW_VERBS =
	/\b(open in.*window|new window|separate window|pop.?out|detach)\b.{0,40}\bview\b|\bview\b.{0,40}\b(new window|separate window|pop.?out|detach)\b/i;
const SPLIT_VERBS =
	/\b(split|side.?by.?side|next to|beside|alongside|left|right|top|bottom)\b.{0,80}\b(views?|apps?|panels?|windows?|tabs?)\b|\b(views?|apps?|panels?|windows?|tabs?)\b.{0,80}\b(split|side.?by.?side|next to|beside|alongside|left|right|top|bottom)\b/i;
const TILE_VERBS =
	/\b(tile|grid|arrange|layout)\b.{0,80}\b(views?|apps?|panels?|windows?|tabs?)\b|\b(views?|apps?|panels?|windows?|tabs?)\b.{0,80}\b(tile|grid|arrange|layout)\b/i;
const LAYOUT_OVERRIDE_MODES = new Set([
	"create",
	"delete",
	"edit",
	"list",
	"open",
	"remove",
	"show",
]);
const VIEW_SURFACE_TOKENS = new Set([
	"app",
	"apps",
	"desktop",
	"manager",
	"panel",
	"panels",
	"screen",
	"screens",
	"tab",
	"tabs",
	"ui",
	"view",
	"views",
	"window",
	"windows",
]);
const USER_REQUEST_OPEN_TAG = "<user_request>";
const USER_REQUEST_CLOSE_TAG = "</user_request>";

function extractUserRequestText(text: string): string | null {
	const start = text.lastIndexOf(USER_REQUEST_OPEN_TAG);
	if (start < 0) return null;
	const contentStart = start + USER_REQUEST_OPEN_TAG.length;
	const end = text.indexOf(USER_REQUEST_CLOSE_TAG, contentStart);
	if (end < 0) return null;
	const value = text.slice(contentStart, end).trim();
	return value.length > 0 ? value : null;
}

function viewRequestText(text: string): string {
	return extractUserRequestText(text) ?? text;
}

function readViewTypeOption(
	text: string,
	options?: Record<string, unknown>,
): ViewType | undefined {
	const requestText = viewRequestText(text);
	const explicit =
		readStringOption(options, "viewType") ??
		readStringOption(options, "type") ??
		readStringOption(options, "surface");
	const normalized = explicit?.trim().toLowerCase();
	if (normalized === "gui" || normalized === "graphical") return "gui";
	if (normalized === "tui" || normalized === "terminal") return "tui";
	if (
		normalized === "xr" ||
		normalized === "spatial" ||
		normalized === "immersive"
	)
		return "xr";

	if (/\b(tui|terminal)\b/i.test(requestText)) return "tui";
	if (/\b(xr|spatial|immersive)\b/i.test(requestText)) return "xr";
	if (/\b(gui|graphical)\b/i.test(requestText)) return "gui";
	return undefined;
}

function readExplicitViewTypeOption(
	options?: Record<string, unknown>,
): ViewType | undefined {
	const normalized = readStringOption(options, "viewType")
		?.trim()
		.toLowerCase();
	if (normalized === "gui" || normalized === "graphical") return "gui";
	if (normalized === "tui" || normalized === "terminal") return "tui";
	if (
		normalized === "xr" ||
		normalized === "spatial" ||
		normalized === "immersive"
	)
		return "xr";
	return undefined;
}

function readBooleanOption(
	options: Record<string, unknown> | undefined,
	key: string,
): boolean {
	if (!options) return false;
	const value = options[key];
	if (typeof value === "boolean") return value;
	if (typeof value !== "string") return false;
	return /^(1|true|yes|on)$/i.test(value.trim());
}

async function resolveViewTypeForId(
	client: ViewsClient,
	viewId: string,
	explicitViewType?: ViewType,
): Promise<ViewType | undefined> {
	if (explicitViewType) return explicitViewType;
	const views = await client.listViews();
	return views.find((view) => view.id === viewId)?.viewType;
}

type OwnerAccessFn = (
	runtime: IAgentRuntime,
	message: Memory,
) => Promise<boolean>;

interface ViewsActionDeps {
	client?: ViewsClient;
	hasOwnerAccess?: OwnerAccessFn;
	repoRoot?: string;
}

function defaultRepoRoot(): string {
	const fromEnv =
		process.env.ELIZA_REPO_ROOT?.trim() ||
		process.env.ELIZA_WORKSPACE_DIR?.trim();
	if (fromEnv && path.isAbsolute(fromEnv)) return fromEnv;
	return process.cwd();
}

function inferMode(
	text: string,
	options?: Record<string, unknown>,
): ViewsMode | null {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const trimmed = viewRequestText(text).trim();
	const normalizedExplicit = explicit?.trim().toLowerCase().replace(/-/g, "_");
	if (
		normalizedExplicit === "close" ||
		normalizedExplicit === "close_view" ||
		normalizedExplicit === "close_all" ||
		normalizedExplicit === "close_all_views"
	) {
		return "close";
	}
	if (
		normalizedExplicit === "split" ||
		normalizedExplicit === "split_view" ||
		normalizedExplicit === "split_views"
	) {
		if (isTileLayoutRequest(trimmed) && !isSplitLayoutRequest(trimmed)) {
			return "tile";
		}
		return "split";
	}
	if (
		(normalizedExplicit === "tile" ||
			normalizedExplicit === "tile_view" ||
			normalizedExplicit === "tile_views") &&
		isSplitLayoutRequest(trimmed) &&
		!isTileLayoutRequest(trimmed)
	) {
		return "split";
	}
	if (
		normalizedExplicit === "tile" ||
		normalizedExplicit === "tile_view" ||
		normalizedExplicit === "tile_views"
	) {
		return "tile";
	}
	if (isNonDestructiveCloseRequest(trimmed)) {
		return "close";
	}
	if (
		(normalizedExplicit === "delete" || normalizedExplicit === "remove") &&
		isNonDestructiveCloseRequest(trimmed) &&
		!DELETE_VERBS_RE.test(trimmed)
	) {
		return "close";
	}
	if (normalizedExplicit && isGenericViewNavigationMode(normalizedExplicit)) {
		if (isPinRequest(trimmed)) return "pin";
		if (isWindowRequest(trimmed)) return "window";
		if (isTileLayoutRequest(trimmed)) return "tile";
		if (isSplitLayoutRequest(trimmed)) return "split";
	}
	if (
		normalizedExplicit &&
		!(MODES as readonly string[]).includes(normalizedExplicit)
	) {
		return "interact";
	}
	if (
		normalizedExplicit &&
		(MODES as readonly string[]).includes(normalizedExplicit)
	) {
		if (LAYOUT_OVERRIDE_MODES.has(normalizedExplicit)) {
			if (isPinRequest(trimmed)) return "pin";
			if (isWindowRequest(trimmed)) return "window";
			if (isTileLayoutRequest(trimmed)) return "tile";
			if (isSplitLayoutRequest(trimmed)) return "split";
		}
		return normalizedExplicit as ViewsMode;
	}

	if (!trimmed) return null;

	if (DELETE_VERBS_RE.test(trimmed)) return "delete";
	if (CREATE_VERBS.test(trimmed)) return "create";
	if (EDIT_VERBS_RE.test(trimmed)) return "edit";
	if (isPinRequest(trimmed) || PIN_VERBS.test(trimmed)) return "pin";
	if (isWindowRequest(trimmed) || WINDOW_VERBS.test(trimmed)) return "window";
	if (isTileLayoutRequest(trimmed)) return "tile";
	if (isSplitLayoutRequest(trimmed)) return "split";
	if (INTERACT_VERBS.test(trimmed)) return "interact";
	if (BROADCAST_VERBS.test(trimmed)) return "broadcast";
	if (MANAGER_VERBS.test(trimmed)) return "manager";
	if (SHOW_ALL_VIEWS_MANAGER.test(trimmed)) return "manager";
	if (SHOW_APPS_VERBS.test(trimmed)) return "manager";
	if (CLOSE_VERBS.test(trimmed)) return "close";
	if (CLOSE_PREFIX_VERBS.test(trimmed)) return "close";
	if (SEARCH_VERBS.test(trimmed)) return "search";
	if (CURRENT_VIEW_VERBS.test(trimmed)) return "current";
	if (WHAT_VIEWS_VERB.test(trimmed)) return "list";
	if (LIST_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "list";
	if (SHOW_VERBS.test(trimmed) && VIEW_NOUN.test(trimmed)) return "show";
	if (
		/^\s*(show|open|navigate to|go to|switch to|launch|display|bring up|pull up)\b/i.test(
			trimmed,
		)
	)
		return "show";

	return null;
}

function isGenericViewNavigationMode(normalizedExplicit: string): boolean {
	return (
		normalizedExplicit === "open" ||
		normalizedExplicit === "show" ||
		normalizedExplicit === "view" ||
		normalizedExplicit === "open_view" ||
		normalizedExplicit === "show_view" ||
		normalizedExplicit === "navigate" ||
		normalizedExplicit === "navigate_to_view" ||
		normalizedExplicit === "go_to_view" ||
		normalizedExplicit === "switch" ||
		normalizedExplicit === "switch_view"
	);
}

function isTileLayoutRequest(text: string): boolean {
	return (
		TILE_VERBS.test(text) || /^\s*(tile|grid|arrange|layout)\b/i.test(text)
	);
}

function isSplitLayoutRequest(text: string): boolean {
	return (
		SPLIT_VERBS.test(text) ||
		/^\s*(split|side.?by.?side|next to|beside|alongside)\b/i.test(text) ||
		/\b(?:left|right|top|bottom)\b.{0,60}\b(?:screen|side|pane|panel|window|layout)\b/i.test(
			text,
		) ||
		/\b(?:on|to|at)\s+(?:the\s+)?(?:left|right|top|bottom)\b/i.test(text)
	);
}

function normalizedWordSet(text: string): Set<string> {
	return new Set(
		normalizeLooseTerm(text)
			.split(" ")
			.map((token) => token.trim())
			.filter(Boolean),
	);
}

function hasAnyToken(tokens: ReadonlySet<string>, values: readonly string[]) {
	return values.some((value) => tokens.has(value));
}

function mentionsViewSurface(tokens: ReadonlySet<string>): boolean {
	for (const token of tokens) {
		if (VIEW_SURFACE_TOKENS.has(token)) return true;
	}
	return false;
}

function isPinRequest(text: string): boolean {
	const tokens = normalizedWordSet(text);
	return hasAnyToken(tokens, ["dock", "pin"]) && mentionsViewSurface(tokens);
}

function isWindowRequest(text: string): boolean {
	const tokens = normalizedWordSet(text);
	const hasWindowIntent =
		hasAnyToken(tokens, ["detach", "popout", "window", "windows"]) ||
		(tokens.has("pop") && tokens.has("out"));
	if (!hasWindowIntent) return false;
	return (
		hasAnyToken(tokens, [
			"detach",
			"display",
			"launch",
			"new",
			"open",
			"pop",
			"popout",
			"separate",
			"show",
			"window",
			"windows",
		]) && mentionsViewSurface(tokens)
	);
}

function isLikelyViewContentOperation(text: string): boolean {
	if (/\b(views?|apps?|panels?|windows?|tabs?|screen|layout)\b/i.test(text)) {
		return false;
	}
	return (
		/\b(add|create|make|new|delete|remove|edit|update|show|list|get|read)\b/i.test(
			text,
		) &&
		/\b(notes?|events?|tasks?|todos?|records?|items?|entries?|reminders?)\b/i.test(
			text,
		)
	);
}

function isNonDestructiveCloseRequest(text: string): boolean {
	return (
		CLOSE_ALL_VERBS.test(text) ||
		CLOSE_VERBS.test(text) ||
		CLOSE_PREFIX_VERBS.test(text)
	);
}

function extractSearchQuery(
	text: string,
	options?: Record<string, unknown>,
): string {
	const explicit =
		readStringOption(options, "query") ?? readStringOption(options, "search");
	if (explicit) return explicit;

	// Strip "search views <query>" / "find view <query>"
	const match = text.match(
		/\b(?:search|find|look for|filter)\b.*?\bview[s]?\b\s+(.+)/i,
	);
	return match?.[1]?.trim() ?? text.trim();
}

const CLOSE_TARGET_VERBS = ["close", "dismiss", "hide", "exit", "quit"];
const CLOSE_TARGET_FILLER = new Set([
	"the",
	"view",
	"app",
	"panel",
	"window",
	"tab",
	"please",
	"pls",
	"now",
]);

function readViewTargetOption(
	options?: Record<string, unknown>,
): string | null {
	return (
		readStringOption(options, "view") ??
		readStringOption(options, "viewId") ??
		readStringOption(options, "id") ??
		readStringOption(options, "name") ??
		readStringOption(options, "target")
	);
}

const CAPABILITY_PARAM_RESERVED_KEYS = new Set([
	"action",
	"mode",
	"view",
	"viewId",
	"id",
	"name",
	"target",
	"views",
	"viewIds",
	"targets",
	"layout",
	"placement",
	"query",
	"search",
	"viewType",
	"capability",
	"params",
	"timeoutMs",
	"eventType",
	"event",
	"type",
	"payload",
	"alwaysOnTop",
	"intent",
	"editTarget",
	"choice",
	"confirm",
]);

type ResolvedViewCapability = {
	view: ViewSummary;
	capability: ViewCapability;
};

type OperationFamily = "create" | "read" | "update" | "delete" | "select";

const OPERATION_TOKEN_FAMILIES: Record<OperationFamily, Set<string>> = {
	create: new Set(["create", "add", "new", "make", "build", "generate"]),
	read: new Set([
		"get",
		"show",
		"read",
		"list",
		"view",
		"display",
		"state",
		"contents",
		"current",
	]),
	update: new Set(["update", "edit", "change", "rename", "set", "modify"]),
	delete: new Set(["delete", "remove", "clear", "destroy"]),
	select: new Set(["select", "choose", "pick"]),
};

function normalizeCapabilityKey(value: string | null | undefined): string {
	return (value ?? "")
		.trim()
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokensFor(value: string | null | undefined): Set<string> {
	const normalized = normalizeCapabilityKey(value);
	if (!normalized) return new Set();
	return new Set(normalized.split(" ").filter(Boolean));
}

function operationFamilyForTokens(tokens: Set<string>): OperationFamily | null {
	for (const [family, familyTokens] of Object.entries(
		OPERATION_TOKEN_FAMILIES,
	) as [OperationFamily, Set<string>][]) {
		for (const token of tokens) {
			if (familyTokens.has(token)) return family;
		}
	}
	return null;
}

function operationFamilyForCapability(
	capability: ViewCapability,
): OperationFamily | null {
	return operationFamilyForTokens(
		tokensFor(`${capability.id} ${capability.description ?? ""}`),
	);
}

function viewTokens(view: ViewSummary): Set<string> {
	return tokensFor(
		[view.id, view.label, view.description, ...(view.tags ?? [])].join(" "),
	);
}

function capabilityTokens(capability: ViewCapability): Set<string> {
	return tokensFor(
		[
			capability.id,
			capability.description,
			...Object.keys(capability.params ?? {}),
		].join(" "),
	);
}

function countIntersection(left: Set<string>, right: Set<string>): number {
	let count = 0;
	for (const value of left) {
		if (right.has(value)) count++;
	}
	return count;
}

function capabilityCandidates(
	views: readonly ViewSummary[],
	viewType?: ViewType,
): ResolvedViewCapability[] {
	return views
		.filter((view) => !viewType || !view.viewType || view.viewType === viewType)
		.flatMap((view) =>
			(view.capabilities ?? []).map((capability) => ({ view, capability })),
		);
}

function resolveViewTarget(
	target: string | null,
	views: readonly ViewSummary[],
): ViewSummary | null {
	if (!target) return null;
	const match = resolveCloseTargetView(target, views);
	return match.kind === "match" ? match.view : null;
}

function isViewPluginAuthoringRequest(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (
		mode !== "create" &&
		mode !== "edit" &&
		mode !== "delete" &&
		mode !== "remove"
	) {
		return false;
	}
	if (
		readStringOption(options, "editTarget") ||
		readStringOption(options, "choice") ||
		readStringOption(options, "confirm")
	) {
		return true;
	}
	if (hasExplicitViewCapabilityIntent(text, options)) {
		return false;
	}
	const intent = readStringOption(options, "intent");
	const source = `${text} ${intent ?? ""}`;
	return /\b(view|views|plugin|plugins)\b/i.test(source);
}

function hasExplicitViewCapabilityIntent(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (readStringOption(options, "capability")) return true;

	const explicitAction =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const actionIsMode =
		!!explicitAction &&
		(MODES as readonly string[]).includes(explicitAction.trim().toLowerCase());
	if (explicitAction && !actionIsMode) return true;

	const intent = readStringOption(options, "intent");
	const source = `${text} ${intent ?? ""}`;
	return /\b(capability|interact|invoke)\b/i.test(source);
}

function isViewNavigationRequest(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const explicit =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const source = `${text} ${explicit ?? ""}`;
	if (mode === "open") return true;
	if (
		/\b(open|launch|switch to|go to|navigate to|pull up|bring up)\b/i.test(
			source,
		)
	) {
		return true;
	}
	if (
		(mode === "show" || mode === "list") &&
		/\b(view|views|app|apps|panel|panels|tab|tabs|window|windows)\b/i.test(
			source,
		)
	) {
		return true;
	}
	return false;
}

function shouldResolveModeAsCapability(
	mode: ViewsMode,
	text: string,
	options?: Record<string, unknown>,
): boolean {
	if (isViewPluginAuthoringRequest(mode, text, options)) return false;
	if (isViewNavigationRequest(mode, text, options)) return false;
	return (
		mode === "create" ||
		mode === "edit" ||
		mode === "delete" ||
		mode === "remove" ||
		mode === "show" ||
		mode === "list"
	);
}

function resolveViewCapability({
	views,
	text,
	options,
	viewType,
	currentViewId,
}: {
	views: readonly ViewSummary[];
	text: string;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	currentViewId?: string | null;
}): ResolvedViewCapability | null {
	const explicitCapability = readStringOption(options, "capability");
	const explicitAction =
		readStringOption(options, "action") ?? readStringOption(options, "mode");
	const actionIsMode =
		!!explicitAction &&
		(MODES as readonly string[]).includes(explicitAction.trim().toLowerCase());
	const actionToken = actionIsMode ? null : explicitAction;
	const requestedView = resolveViewTarget(readViewTargetOption(options), views);
	const currentView = views.find((view) => view.id === currentViewId) ?? null;
	const candidates = capabilityCandidates(views, viewType);

	if (explicitCapability) {
		const normalized = normalizeCapabilityKey(explicitCapability);
		const exactCandidates = candidates.filter(
			(candidate) =>
				normalizeCapabilityKey(candidate.capability.id) === normalized &&
				(!requestedView || candidate.view.id === requestedView.id),
		);
		if (requestedView && exactCandidates[0]) return exactCandidates[0];
		const currentExact = exactCandidates.find(
			(candidate) => candidate.view.id === currentView?.id,
		);
		if (currentExact) return currentExact;
		if (exactCandidates.length === 1) return exactCandidates[0];
	}

	const sourceText = [actionToken ?? text, explicitCapability]
		.filter(Boolean)
		.join(" ");
	const sourceTokens = tokensFor(sourceText);
	const sourceOperation = operationFamilyForTokens(sourceTokens);
	let best: { candidate: ResolvedViewCapability; score: number } | null = null;

	for (const candidate of candidates) {
		const vTokens = viewTokens(candidate.view);
		const cTokens = capabilityTokens(candidate.capability);
		const capOperation = operationFamilyForCapability(candidate.capability);
		if (
			explicitCapability &&
			sourceOperation &&
			capOperation &&
			capOperation !== sourceOperation
		) {
			continue;
		}
		const viewMatches =
			requestedView?.id === candidate.view.id ||
			countIntersection(sourceTokens, vTokens) > 0 ||
			currentView?.id === candidate.view.id;
		if (!viewMatches) continue;

		let score = 0;
		if (requestedView?.id === candidate.view.id) score += 5;
		if (currentViewId === candidate.view.id) score += 2;
		score += countIntersection(sourceTokens, vTokens) * 2;
		score += countIntersection(sourceTokens, cTokens);
		if (sourceOperation && capOperation === sourceOperation) score += 4;
		if (
			actionToken &&
			normalizeCapabilityKey(actionToken) ===
				normalizeCapabilityKey(candidate.capability.id)
		) {
			score += 8;
		}
		if (sourceTokens.size > 0) {
			const combined = new Set([...vTokens, ...cTokens]);
			if ([...sourceTokens].every((token) => combined.has(token))) {
				score += 3;
			}
		}

		if (score >= 5 && (!best || score > best.score)) {
			best = { candidate, score };
		}
	}

	return best?.candidate ?? null;
}

function readCapabilityParams(
	options: Record<string, unknown> | undefined,
	capability?: ViewCapability | null,
	resolvedView?: ViewSummary | null,
	messageText?: string,
): Record<string, unknown> | undefined {
	const params: Record<string, unknown> = {};
	const capabilityParamKeys = new Set(Object.keys(capability?.params ?? {}));
	const nested = options?.params;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		Object.assign(params, nested);
	}

	for (const [key, value] of Object.entries(options ?? {})) {
		if (key.startsWith("params.")) {
			const paramKey = key.slice("params.".length).trim();
			if (paramKey) params[paramKey] = value;
			continue;
		}
		if (capabilityParamKeys.has(key)) {
			params[key] = value;
			continue;
		}
		if (!CAPABILITY_PARAM_RESERVED_KEYS.has(key)) {
			params[key] = value;
		}
	}

	const unresolvedTarget = readViewTargetOption(options);
	const capabilityFamily = capability
		? operationFamilyForCapability(capability)
		: null;
	if (
		capabilityFamily !== "delete" &&
		unresolvedTarget &&
		!targetMatchesResolvedView(unresolvedTarget, resolvedView) &&
		!params.title &&
		capabilityParamKeys.has("title")
	) {
		params.title = unresolvedTarget;
	} else if (
		capabilityFamily !== "delete" &&
		unresolvedTarget &&
		!targetMatchesResolvedView(unresolvedTarget, resolvedView) &&
		!params.name &&
		capabilityParamKeys.has("name")
	) {
		params.name = unresolvedTarget;
	}

	const intent = readStringOption(options, "intent");
	if (intent) {
		Object.assign(
			params,
			deriveParamsFromIntent(intent, capabilityParamKeys, params),
		);
	}
	if (messageText && capability) {
		Object.assign(
			params,
			deriveParamsFromMessageText(
				messageText,
				capability,
				capabilityParamKeys,
				params,
			),
		);
	}

	for (const key of Object.keys(params)) {
		if (
			params[key] === undefined ||
			params[key] === null ||
			params[key] === ""
		) {
			delete params[key];
		}
	}

	return Object.keys(params).length > 0 ? params : undefined;
}

function deriveParamsFromIntent(
	intent: string,
	capabilityParamKeys: Set<string>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const derived: Record<string, unknown> = {};
	const trimmed = intent.trim();
	if (!trimmed) return derived;

	const title = extractIntentTitle(trimmed);
	if (capabilityParamKeys.has("title") && !existing.title) {
		derived.title = title ?? trimmed;
	}
	const body = extractIntentTextAfter(trimmed, ["body", "content"]);
	if (capabilityParamKeys.has("body") && !existing.body && body) {
		derived.body = body;
	}
	const notes = extractIntentTextAfter(trimmed, ["notes", "note"]);
	if (capabilityParamKeys.has("notes") && !existing.notes && notes) {
		derived.notes = notes;
	}
	const date = extractIsoDate(trimmed);
	if (capabilityParamKeys.has("date") && !existing.date && date) {
		derived.date = date;
	}
	const time = extractClockTime(trimmed);
	if (capabilityParamKeys.has("time") && !existing.time && time) {
		derived.time = time;
	}

	return derived;
}

function extractIntentTitle(intent: string): string | null {
	const titled =
		/\btitled?\s+["']?(.+?)(?:["']?\s+\b(?:with|on|at|for)\b|["']?$)/i.exec(
			intent,
		);
	if (titled?.[1]?.trim()) {
		return titled[1].trim();
	}
	const quoted = /["']([^"']{1,160})["']/.exec(intent);
	return quoted?.[1]?.trim() ?? null;
}

function extractIntentTextAfter(
	intent: string,
	labels: readonly string[],
): string | null {
	for (const label of labels) {
		const match = new RegExp(`\\b(?:with\\s+)?${label}\\s+(.+)$`, "i").exec(
			intent,
		);
		if (match?.[1]?.trim()) return match[1].trim();
	}
	return null;
}

function deriveParamsFromMessageText(
	text: string,
	capability: ViewCapability,
	capabilityParamKeys: Set<string>,
	existing: Record<string, unknown>,
): Record<string, unknown> {
	const derived: Record<string, unknown> = {};
	const trimmed = text.trim();
	if (!trimmed) return derived;

	const family = operationFamilyForCapability(capability);
	if (family === "create") {
		const body = extractIntentTextAfter(trimmed, [
			"body",
			"content",
			"saying",
			"says",
			"say",
		]);
		if (capabilityParamKeys.has("body") && !existing.body && body) {
			derived.body = body;
		}
		const title = extractIntentTitle(trimmed);
		if (capabilityParamKeys.has("title") && !existing.title && title) {
			derived.title = title;
		}
	}

	if (family === "delete") {
		if (existing.id || existing.query || existing.title || existing.name) {
			return derived;
		}
		const target = extractDeleteTargetText(trimmed);
		if (target) {
			if (capabilityParamKeys.has("query")) {
				derived.query = target;
			} else if (capabilityParamKeys.has("title")) {
				derived.title = target;
			} else if (capabilityParamKeys.has("name")) {
				derived.name = target;
			}
		}
	}

	return derived;
}

function extractDeleteTargetText(text: string): string | null {
	const match =
		/\b(?:delete|remove|drop|destroy)\s+(?:the\s+)?(.+?)(?:\s+(?:note|notes|event|events|record|records|item|items))?\s*$/i.exec(
			text,
		);
	const target = match?.[1]?.trim();
	if (!target) return null;
	const cleaned = target
		.replace(/\b(?:sticky|calendar)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : null;
}

function extractIsoDate(intent: string): string | null {
	return /\b(\d{4}-\d{2}-\d{2})\b/.exec(intent)?.[1] ?? null;
}

function extractClockTime(intent: string): string | null {
	return /\b(?:at|time)\s+(\d{1,2}:\d{2})\b/i.exec(intent)?.[1] ?? null;
}

function targetMatchesResolvedView(
	target: string,
	resolvedView?: ViewSummary | null,
): boolean {
	const normalizedTarget = normalizeCapabilityKey(target);
	return !!(
		resolvedView &&
		(normalizeCapabilityKey(resolvedView.id) === normalizedTarget ||
			normalizeCapabilityKey(resolvedView.label) === normalizedTarget)
	);
}

function isCloseAllRequest(
	text: string,
	options?: Record<string, unknown>,
): boolean {
	const requestText = viewRequestText(text);
	const explicit = readViewTargetOption(options)?.trim().toLowerCase();
	return (
		readBooleanOption(options, "all") ||
		explicit === "all" ||
		explicit === "__all__" ||
		CLOSE_ALL_VERBS.test(requestText)
	);
}

function extractCloseTarget(
	text: string,
	options?: Record<string, unknown>,
): string | null {
	const explicit = readViewTargetOption(options);
	if (explicit) return explicit;

	const requestText = viewRequestText(text);
	const lower = requestText.toLowerCase();
	for (const verb of CLOSE_TARGET_VERBS) {
		const idx = lower.indexOf(verb);
		if (idx === -1) continue;
		const rest = requestText.slice(idx + verb.length).trim();
		if (!rest) continue;
		const tokens = rest
			.split(/[\s,!.?]+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);
		let start = 0;
		while (
			start < tokens.length &&
			CLOSE_TARGET_FILLER.has(tokens[start].toLowerCase())
		) {
			start++;
		}
		let end = tokens.length;
		while (
			end > start &&
			CLOSE_TARGET_FILLER.has(tokens[end - 1].toLowerCase())
		) {
			end--;
		}
		const candidate = tokens.slice(start, end).join(" ").toLowerCase();
		if (
			candidate &&
			candidate !== "all" &&
			candidate !== "current" &&
			!CLOSE_TARGET_FILLER.has(candidate)
		) {
			return candidate;
		}
	}

	return null;
}

function resolveCloseTargetView(
	target: string,
	views: readonly ViewSummary[],
):
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" } {
	const q = target.toLowerCase();
	const byId = views.find((view) => view.id.toLowerCase() === q);
	if (byId) return { kind: "match", view: byId };

	const byLabel = views.find((view) => view.label.toLowerCase() === q);
	if (byLabel) return { kind: "match", view: byLabel };

	const normalizedTarget = normalizeLooseTerm(target);
	const byLooseId = views.find(
		(view) => normalizeLooseTerm(view.id) === normalizedTarget,
	);
	if (byLooseId) return { kind: "match", view: byLooseId };

	const byLooseLabel = views.find(
		(view) => normalizeLooseTerm(view.label) === normalizedTarget,
	);
	if (byLooseLabel) return { kind: "match", view: byLooseLabel };

	const byTag = views.find((view) =>
		(view.tags ?? []).some(
			(tag) =>
				tag.toLowerCase() === q || normalizeLooseTerm(tag) === normalizedTarget,
		),
	);
	if (byTag) return { kind: "match", view: byTag };

	const scored = views
		.map((view) => ({ view, score: scoreView(view, target) }))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score);
	if (scored.length === 0) return { kind: "none" };
	if (scored.length === 1) return { kind: "match", view: scored[0].view };

	const topScore = scored[0].score;
	const topTied = scored.filter(({ score }) => score === topScore);
	if (topTied.length === 1) return { kind: "match", view: topTied[0].view };

	return { kind: "ambiguous", candidates: topTied.map(({ view }) => view) };
}

function uniqueStrings(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLooseTerm(value: string): string {
	return value
		.toLowerCase()
		.replace(/[-_./]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function textMentionsTerm(normalizedText: string, term: string): boolean {
	const normalizedTerm = normalizeLooseTerm(term);
	if (normalizedTerm.length < 3) return false;
	const re = new RegExp(`(?:^|\\W)${escapeRegExp(normalizedTerm)}(?:\\W|$)`);
	return re.test(normalizedText);
}

function readStringListOption(
	options: Record<string, unknown> | undefined,
	key: string,
): string[] {
	const value = options?.[key];
	if (Array.isArray(value)) {
		return uniqueStrings(
			value.filter((item): item is string => typeof item === "string"),
		);
	}
	if (typeof value !== "string") return [];
	return uniqueStrings(value.split(/[,|]/));
}

function readLayoutTargetsFromOptions(
	options?: Record<string, unknown>,
): string[] {
	const singleValueKeys = [
		"view",
		"id",
		"name",
		"target",
		"withView",
		"secondaryView",
	];
	return uniqueStrings([
		...readStringListOption(options, "views"),
		...readStringListOption(options, "viewIds"),
		...readStringListOption(options, "targets"),
		...singleValueKeys
			.map((key) => readStringOption(options, key))
			.filter((value): value is string => typeof value === "string"),
	]);
}

function hasCapabilityPayloadOptions(
	options?: Record<string, unknown>,
): boolean {
	for (const [key, value] of Object.entries(options ?? {})) {
		if (value === undefined || value === null || value === "") continue;
		if (
			key === "params" &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.keys(value).length > 0
		) {
			return true;
		}
		if (key.startsWith("params.")) return true;
		if (!CAPABILITY_PARAM_RESERVED_KEYS.has(key)) return true;
	}
	return false;
}

function preferLayoutModeOverCapability({
	text,
	options,
	views,
}: {
	text: string;
	options?: Record<string, unknown>;
	views: readonly ViewSummary[];
}): "split" | "tile" | null {
	const trimmed = viewRequestText(text).trim();
	if (!trimmed || hasCapabilityPayloadOptions(options)) return null;

	const mode = isTileLayoutRequest(trimmed)
		? "tile"
		: isSplitLayoutRequest(trimmed)
			? "split"
			: null;
	if (!mode) return null;
	if (isLikelyViewContentOperation(trimmed)) return null;

	const targets = resolveLayoutTargets(trimmed, options, views);
	return targets.length > 0 ? mode : null;
}

function resolveLayoutTargets(
	text: string,
	options: Record<string, unknown> | undefined,
	views: readonly ViewSummary[],
): ViewSummary[] {
	const explicit = readLayoutTargetsFromOptions(options);
	const explicitResolved: ViewSummary[] = [];
	for (const target of explicit) {
		const match = resolveCloseTargetView(target, views);
		if (match.kind === "match") explicitResolved.push(match.view);
	}

	const requestText = viewRequestText(text);
	const lower = requestText.toLowerCase();
	const normalizedText = normalizeLooseTerm(requestText);
	const textResolved: ViewSummary[] = [];
	for (const view of views) {
		const id = view.id.toLowerCase();
		const label = view.label.toLowerCase();
		const normalizedLabel = normalizeLooseTerm(label);
		const labelIsGenericSurface = VIEW_SURFACE_TOKENS.has(normalizedLabel);
		const terms = [
			id,
			...(labelIsGenericSurface ? [] : [label]),
			...(view.tags ?? []).filter(
				(tag) => !VIEW_SURFACE_TOKENS.has(normalizeLooseTerm(tag)),
			),
		];
		if (
			lower.includes(id) ||
			(!labelIsGenericSurface && label.length >= 3 && lower.includes(label)) ||
			terms.some((term) => textMentionsTerm(normalizedText, term))
		) {
			textResolved.push(view);
		}
	}

	const explicitUnique = uniqueByViewId(explicitResolved);
	const textUnique = uniqueByViewId(textResolved);
	return textUnique.length >= 2
		? textUnique
		: textUnique.length === 1 && explicitUnique.length <= 1
			? textUnique
			: uniqueByViewId([...explicitUnique, ...textUnique]);
}

function isLayoutOnlyFollowupRequest(
	text: string,
	views: readonly ViewSummary[],
): boolean {
	const requestText = viewRequestText(text).trim();
	if (!requestText) return false;
	if (resolveLayoutTargets(requestText, undefined, views).length > 0)
		return false;
	return /\b(instead|again|horizontal|vertical|row|column|stack|side.?by.?side|left-right|top-bottom)\b/i.test(
		requestText,
	);
}

async function resolveSingleShellTargetView({
	client,
	text,
	options,
	viewType,
}: {
	client: ViewsClient;
	text: string;
	options?: Record<string, unknown>;
	viewType?: ViewType;
}): Promise<
	| { kind: "match"; view: ViewSummary }
	| { kind: "ambiguous"; candidates: ViewSummary[] }
	| { kind: "none" }
> {
	const requestText = viewRequestText(text);
	const explicit = readViewTargetOption(options)?.trim();
	if (
		explicit?.toLowerCase() === "current" ||
		(!explicit && /\bcurrent\b/i.test(requestText))
	) {
		const currentView = await client.getCurrentView().catch(() => null);
		if (!currentView?.viewId) return { kind: "none" };
		return {
			kind: "match",
			view: {
				id: currentView.viewId,
				label: currentView.viewLabel ?? currentView.viewId,
				available: true,
				pluginName: "current",
				viewType: currentView.viewType ?? viewType ?? "gui",
				...(currentView.viewPath ? { path: currentView.viewPath } : {}),
			},
		};
	}

	const views = await client.listViews({ viewType });
	if (explicit) return resolveCloseTargetView(explicit, views);

	const targets = resolveLayoutTargets(requestText, undefined, views);
	if (targets.length === 1) return { kind: "match", view: targets[0] };
	if (targets.length > 1) return { kind: "ambiguous", candidates: targets };
	return { kind: "none" };
}

function uniqueByViewId(views: readonly ViewSummary[]): ViewSummary[] {
	const byId = new Map<string, ViewSummary>();
	for (const view of views) byId.set(view.id, view);
	return [...byId.values()];
}

function readLayoutValue(
	text: string,
	options?: Record<string, unknown>,
): "horizontal" | "vertical" | "grid" {
	const requestText = viewRequestText(text);
	const explicit =
		readStringOption(options, "layout") ??
		readStringOption(options, "orientation") ??
		readStringOption(options, "direction");
	const value = explicit?.trim().toLowerCase();
	if (
		value === "horizontal" ||
		value === "left-right" ||
		value === "row" ||
		value === "side-by-side"
	)
		return "horizontal";
	if (
		value === "vertical" ||
		value === "top-bottom" ||
		value === "column" ||
		value === "stack"
	)
		return "vertical";
	if (value === "grid" || value === "tile" || value === "tiled") return "grid";

	if (/\b(left|right|horizontal|side.?by.?side)\b/i.test(requestText)) {
		return "horizontal";
	}
	if (/\b(next to|beside|alongside)\b/i.test(requestText)) return "horizontal";
	if (/\b(top|bottom|vertical|stack)\b/i.test(requestText)) return "vertical";
	return "grid";
}

function readPlacementValue(
	text: string,
	options?: Record<string, unknown>,
): "left" | "right" | "top" | "bottom" | undefined {
	const requestText = viewRequestText(text);
	const explicit = readStringOption(options, "placement")?.trim().toLowerCase();
	if (
		explicit === "left" ||
		explicit === "right" ||
		explicit === "top" ||
		explicit === "bottom"
	) {
		return explicit;
	}
	const match = /\b(left|right|top|bottom)\b/i.exec(requestText);
	const value = match?.[1]?.toLowerCase();
	if (
		value === "left" ||
		value === "right" ||
		value === "top" ||
		value === "bottom"
	) {
		return value;
	}
	return undefined;
}

function layoutForPlacement(
	placement?: "left" | "right" | "top" | "bottom",
): "horizontal" | "vertical" | undefined {
	if (placement === "left" || placement === "right") return "horizontal";
	if (placement === "top" || placement === "bottom") return "vertical";
	return undefined;
}

async function completeSplitTargetsWithCurrentView({
	client,
	targets,
	views,
	placement,
}: {
	client: ViewsClient;
	targets: ViewSummary[];
	views: readonly ViewSummary[];
	placement?: "left" | "right" | "top" | "bottom";
}): Promise<ViewSummary[]> {
	if (targets.length !== 1) return targets;
	const currentView = await client.getCurrentView().catch(() => null);
	const currentId = currentView?.viewId;
	if (!currentId || currentId === targets[0].id) return targets;
	const currentSummary = views.find((view) => view.id === currentId);
	if (!currentSummary) return targets;

	if (placement === "left" || placement === "top") {
		return [targets[0], currentSummary];
	}
	return [currentSummary, targets[0]];
}

async function completeSplitTargetsFromCurrentLayout({
	client,
	targets,
	views,
	preferCurrentLayout,
}: {
	client: ViewsClient;
	targets: ViewSummary[];
	views: readonly ViewSummary[];
	preferCurrentLayout?: boolean;
}): Promise<ViewSummary[]> {
	const currentView = await client.getCurrentView().catch(() => null);
	const currentLayoutIds = currentView?.views ?? [];
	const byId = new Map(views.map((view) => [view.id, view]));
	if (currentLayoutIds.some((viewId) => !byId.has(viewId))) {
		const unfilteredViews = await client.listViews().catch(() => []);
		for (const view of unfilteredViews) byId.set(view.id, view);
	}
	const currentTargets = currentLayoutIds.map((viewId) => {
		const summary = byId.get(viewId);
		if (summary) return summary;
		return {
			id: viewId,
			label: viewId === currentView?.viewId ? currentView.viewLabel : viewId,
			available: true,
			pluginName: "current-layout",
			viewType: currentView?.viewType ?? "gui",
			...(viewId === currentView?.viewId && currentView.viewPath
				? { path: currentView.viewPath }
				: {}),
		};
	});
	if (preferCurrentLayout && currentTargets.length >= 2) return currentTargets;
	if (targets.length >= 2) return targets;
	return currentTargets.length >= 2 ? currentTargets : targets;
}

async function runViewsClose({
	client,
	message,
	options,
	viewType,
	callback,
}: {
	client: ViewsClient;
	message: Memory;
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const text = message.content.text ?? "";
	if (isCloseAllRequest(text, options)) {
		const resultText = await navigateViewWithShellAction(
			"__all__",
			"close-all",
			"Closed all views.",
			"Requested closing all views.",
		);
		await callback?.({ text: resultText });
		return {
			success: true,
			text: resultText,
			values: { mode: "close", scope: "all" },
			data: { viewId: "__all__", action: "close-all" },
		};
	}

	const target = extractCloseTarget(text, options);
	let viewId: string | null = null;
	let label: string | null = null;
	let resolvedViewType: ViewType | undefined;

	if (!target || target.toLowerCase() === "current") {
		const currentView = await client.getCurrentView();
		viewId = currentView?.viewId ?? null;
		label = currentView?.viewLabel ?? null;
		resolvedViewType = viewType ?? currentView?.viewType;
		if (!viewId) {
			const reply =
				"No current view has been reported yet. Tell me which view to close.";
			await callback?.({ text: reply });
			return { success: false, text: reply };
		}
	} else {
		const views = await client.listViews({ viewType });
		const resolution = resolveCloseTargetView(target, views);
		if (resolution.kind === "none") {
			const reply = `No view matches "${target}". Try action=list to see available views.`;
			await callback?.({ text: reply });
			return { success: false, text: reply, data: { target } };
		}
		if (resolution.kind === "ambiguous") {
			const list = resolution.candidates
				.map((view) => `- ${view.label} (${view.id})`)
				.join("\n");
			const reply = `"${target}" matches multiple views:\n${list}\nWhich one did you mean?`;
			await callback?.({ text: reply });
			return {
				success: false,
				text: reply,
				data: { candidates: resolution.candidates },
			};
		}
		viewId = resolution.view.id;
		label = resolution.view.label;
		resolvedViewType = viewType ?? resolution.view.viewType;
	}

	const resultText = await navigateViewWithShellAction(
		viewId,
		"close",
		`Closed ${label ?? viewId}.`,
		`Requested closing ${label ?? viewId}.`,
		resolvedViewType === "gui" ? undefined : resolvedViewType,
	);
	await callback?.({ text: resultText });
	return {
		success: true,
		text: resultText,
		values: {
			mode: "close",
			viewId,
			viewType: resolvedViewType ?? "gui",
			label: label ?? viewId,
		},
		data: { viewId, viewType: resolvedViewType ?? "gui", action: "close" },
	};
}

async function runViewsLayout({
	client,
	message,
	mode,
	options,
	viewType,
	callback,
}: {
	client: ViewsClient;
	message: Memory;
	mode: "split" | "tile";
	options?: Record<string, unknown>;
	viewType?: ViewType;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	const text = message.content.text ?? "";
	const views = await client.listViews({ viewType });
	const placement =
		mode === "split" ? readPlacementValue(text, options) : undefined;
	const layoutOnlyFollowup =
		mode === "split" ? isLayoutOnlyFollowupRequest(text, views) : false;
	let targets =
		mode === "split"
			? await completeSplitTargetsWithCurrentView({
					client,
					targets: resolveLayoutTargets(text, options, views),
					views,
					placement,
				})
			: resolveLayoutTargets(text, options, views);
	if (mode === "split") {
		targets = await completeSplitTargetsFromCurrentLayout({
			client,
			targets,
			views,
			preferCurrentLayout: layoutOnlyFollowup,
		});
	}
	const singleViewPlacement =
		mode === "split" && targets.length === 1 && placement !== undefined;
	if (targets.length < 2 && !singleViewPlacement) {
		const reply =
			mode === "split"
				? 'Tell me two views to split, e.g. action=split views=["notes","calendar"] layout=horizontal.'
				: 'Tell me two or more views to tile, e.g. action=tile views=["notes","calendar"].';
		await callback?.({ text: reply });
		return {
			success: false,
			text: reply,
			data: { mode, resolvedCount: targets.length },
		};
	}

	const layout =
		mode === "tile"
			? "grid"
			: (layoutForPlacement(placement) ?? readLayoutValue(text, options));
	const viewIds = targets.map((view) => view.id);
	const labels = targets.map((view) => view.label).join(", ");
	const action = mode === "split" ? "split-view" : "tile-views";
	const primary = targets[0];
	const resolvedViewType = layoutOnlyFollowup
		? (primary.viewType ?? viewType)
		: (viewType ?? primary.viewType);
	const resultText = await navigateViewLayout({
		viewId: primary.id,
		action,
		viewIds,
		layout,
		placement,
		viewType: resolvedViewType === "gui" ? undefined : resolvedViewType,
		successText: singleViewPlacement
			? `Placed ${labels} on the ${placement}.`
			: mode === "split"
				? `Split views: ${labels} (${layout}).`
				: `Tiled views: ${labels}.`,
		fallbackText: singleViewPlacement
			? `Requested placing ${labels} on the ${placement}.`
			: mode === "split"
				? `Requested split layout for views: ${labels}.`
				: `Requested tiled layout for views: ${labels}.`,
	});
	await callback?.({ text: resultText });
	return {
		success: true,
		text: resultText,
		continueChain: false,
		values: {
			mode,
			viewIds,
			layout,
			...(placement ? { placement } : {}),
		},
		data: {
			viewId: primary.id,
			viewIds,
			action,
			layout,
			...(placement ? { placement } : {}),
		},
	};
}

function withViewsUserFacingText(result: ActionResult): ActionResult {
	const text = typeof result.text === "string" ? result.text.trim() : "";
	if (!text) return result;
	return {
		...result,
		userFacingText: result.userFacingText ?? text,
		verifiedUserFacing:
			result.success === true
				? (result.verifiedUserFacing ?? true)
				: result.verifiedUserFacing,
	};
}

export function createViewsAction(deps: ViewsActionDeps = {}): Action {
	const clientFactory = () => deps.client ?? createViewsClient();
	const ownerCheck = deps.hasOwnerAccess ?? defaultOwnerAccessFn;
	const getRepoRoot = () => deps.repoRoot ?? defaultRepoRoot();

	return {
		name: "VIEWS",
		contexts: [...VIEW_ACTION_CONTEXTS],
		contextGate: { anyOf: [...VIEW_ACTION_CONTEXTS] },
		roleGate: { minRole: "USER" },
		similes: [
			"VIEW",
			"SHOW_VIEW",
			"OPEN_VIEW",
			"CLOSE_VIEW",
			"CLOSE_ALL_VIEWS",
			"LIST_VIEWS",
			"VIEW_MANAGER",
			"VIEWS_LIST",
			"SWITCH_VIEW",
			"SHOW_APPS",
			"OPEN_APPS",
			"GO_TO_VIEW",
			"NAVIGATE_TO_VIEW",
			"WHAT_VIEWS",
			"BROADCAST_VIEW_EVENT",
			"NOTIFY_VIEW",
			"SIGNAL_VIEW",
			"INTERACT_WITH_VIEW",
			"CLICK_IN_VIEW",
			"INVOKE_VIEW_CAPABILITY",
			"PIN_VIEW",
			"OPEN_VIEW_WINDOW",
			"SPLIT_VIEW",
			"SPLIT_VIEWS",
			"TILE_VIEWS",
			"ARRANGE_VIEWS",
			"USE_VIEW_CAPABILITY",
			"CALL_VIEW_CAPABILITY",
			"CREATE_NOTE",
			"CREATE_STICKY_NOTE",
			"SHOW_NOTES",
			"GET_NOTES",
			"LIST_NOTES",
			"CREATE_CALENDAR_EVENT",
			"ADD_CALENDAR_EVENT",
			"GET_CALENDAR_EVENTS",
			"LIST_CALENDAR_EVENTS",
			"CREATE_VIEW",
			"CREATE_PLUGIN",
			"BUILD_VIEW",
			"MAKE_VIEW",
			"EDIT_VIEW",
			"UPDATE_VIEW",
			"DELETE_VIEW",
			"REMOVE_VIEW",
			"REMOVE_PLUGIN",
			"UNINSTALL_VIEW",
		],
		tags: [
			"views",
			"ui",
			"window",
			"panel",
			"app",
			"layout",
			"view-capability",
			"notes",
			"sticky-notes",
			"calendar",
			"events",
		],
		description:
			"Manage and navigate UI views. List available views, report the current view, open a specific view, close/hide a view without deleting its plugin, search views by name or capability, show the view manager, broadcast events to views, invoke registered capabilities on plugin views for view-backed content such as notes, calendar events, dashboards, and records, pin a view as a desktop tab, open a view in a separate window, request split/tiled layouts across multiple views, create a new view plugin (scaffolds + coding agent), edit an existing view plugin (coding agent), or delete/uninstall a view plugin.",
		descriptionCompressed:
			"views list|current|show|open|close|search|manager|broadcast|interact|pin|window|split|tile|create|edit|delete; navigate/close UI views; invoke registered view capabilities for notes/events/dashboards/records; click/read/focus elements; split/tile layouts; scaffold/edit/remove view plugins",
		routingHint:
			"UI view/window/panel/app navigation and layout -> VIEWS. Use VIEWS for open/show/switch/close/hide view requests, view manager, list views, split/tile views, pin view, open view in a separate window, or invoking a capability declared by a registered plugin view, including view-backed content operations like creating/listing notes or calendar events. For add/create calendar-event requests, use action=interact view=calendar capability=create-calendar-event; do not answer by opening or splitting the calendar unless the user asked for layout. Close/hide means VIEWS action=close, not delete/remove. For view capabilities use action=interact with view=<view id> and capability=<capability id>, or pass a generated capability action name that can be resolved from the view catalog. Pass capability data as params={...} or top-level keys such as title/body/date/time/notes/color; never use dotted keys such as params.title.",
		allowAdditionalParameters: true,
		suppressPostActionContinuation: true,

		parameters: [
			{
				name: "action",
				description:
					"Operation: list | current | show | open | close | search | manager | broadcast | interact | pin | window | split | tile | create | edit | delete | remove, or a registered/generated view capability name to resolve through the view catalog.",
				required: true,
				schema: {
					type: "string",
				},
			},
			{
				name: "mode",
				description: "Legacy alias for action.",
				required: false,
				schema: {
					type: "string",
					enum: [...MODES],
				},
			},
			{
				name: "view",
				description:
					"View name, label, or id (show / open / close / edit / delete).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "id",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "name",
				description: "Alias for `view`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "target",
				description:
					"Alias for `view`, especially for close requests such as CLOSE_VIEW { target: 'settings' }.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "views",
				description:
					"Multiple view ids/names for split or tile mode, e.g. ['notes','calendar'].",
				required: false,
				schema: { type: "array", items: { type: "string" } },
			},
			{
				name: "layout",
				description:
					"Layout for split/tile mode: horizontal, vertical, or grid.",
				required: false,
				schema: { type: "string", enum: ["horizontal", "vertical", "grid"] },
			},
			{
				name: "placement",
				description:
					"Optional split placement hint: left, right, top, or bottom.",
				required: false,
				schema: {
					type: "string",
					enum: ["left", "right", "top", "bottom"],
				},
			},
			{
				name: "query",
				description: "Search keyword (search mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "viewType",
				description:
					'Presentation type to use for view discovery and switching. Defaults to "gui"; use "tui" for terminal views and "xr" for spatial views.',
				required: false,
				schema: { type: "string", enum: ["gui", "tui", "xr"] },
			},
			{
				name: "search",
				description: "Alias for `query`.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "eventType",
				description:
					"Event type to broadcast to all mounted views (broadcast mode), e.g. 'wallet:refresh'.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "payload",
				description: "JSON payload to include with the broadcast event.",
				required: false,
				schema: { type: "object", additionalProperties: true },
			},
			{
				name: "capability",
				description:
					"Capability to invoke on the view (interact mode), e.g. 'create-note', 'get-notes', 'create-calendar-event', 'get-calendar-state', 'click-button', 'get-state', 'refresh', or 'focus-element'.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "params",
				description:
					"Object parameters for the capability (interact mode), e.g. { title: 'launch checklist', body: 'test auth' } or { title: 'team sync', date: '2026-06-08', time: '17:00' }. Do not use dotted parameter names like 'params.title'.",
				required: false,
				schema: { type: "object", additionalProperties: true },
			},
			{
				name: "title",
				description:
					"Top-level passthrough for registered view capabilities that accept a title, such as create-note or create-calendar-event.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "body",
				description:
					"Top-level passthrough for registered view capabilities that accept body/content text, such as create-note.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "date",
				description:
					"Top-level passthrough for registered view capabilities that accept an ISO date, such as create-calendar-event.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "time",
				description:
					"Top-level passthrough for registered view capabilities that accept a time label, such as create-calendar-event.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "notes",
				description:
					"Top-level passthrough for registered view capabilities that accept notes/details text, such as create-calendar-event.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "color",
				description:
					"Top-level passthrough for registered view capabilities that accept a color, such as notes or calendar events.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "timeoutMs",
				description: "Timeout in ms for interact responses. Default 5000.",
				required: false,
				schema: { type: "number" },
			},
			{
				name: "alwaysOnTop",
				description:
					"When action=window, request that the detached desktop window stays above normal windows.",
				required: false,
				schema: { type: "boolean" },
			},
			{
				name: "intent",
				description:
					"Free-form description of the view to build (create mode). Defaults to the user message text.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "editTarget",
				description:
					"Skip the picker and edit this installed view directly (create mode).",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "choice",
				description:
					"Override choice reply (`new` | `edit-N` | `cancel`) for create-mode follow-up turns.",
				required: false,
				schema: { type: "string" },
			},
			{
				name: "confirm",
				description:
					'Set to "true" or "yes" to skip the delete confirmation prompt (delete mode).',
				required: false,
				schema: { type: "string" },
			},
		],

		validate: async (
			runtime: IAgentRuntime,
			message: Memory,
		): Promise<boolean> => {
			const text = message.content.text ?? "";
			const roomId =
				typeof message.roomId === "string" ? message.roomId : runtime.agentId;

			// Multi-turn create follow-up: choice reply matches a pending intent task.
			if (isChoiceReply(text)) {
				if (await hasPendingViewsCreateIntent(runtime, roomId)) return true;
			}

			// Multi-turn delete follow-up: yes/no matches a pending confirm task.
			if (isDeleteConfirmation(text) || isDeleteCancellation(text)) {
				if (await hasPendingDeleteConfirm(runtime, roomId)) return true;
			}

			// Create/edit/delete require owner access.
			const mode = inferMode(text, undefined);
			if (
				mode === "create" ||
				mode === "edit" ||
				mode === "delete" ||
				mode === "remove"
			) {
				return ownerCheck(runtime, message);
			}

			// Read modes are visible to all users.
			return true;
		},

		handler: async (
			runtime: IAgentRuntime,
			message: Memory,
			_state?: State,
			options?: Record<string, unknown>,
			callback?: HandlerCallback,
		): Promise<ActionResult> => {
			const run = async (): Promise<ActionResult> => {
				const actionOptions = normalizeActionOptions(options);
				const client = clientFactory();
				const text = message.content.text ?? "";
				const roomId =
					typeof message.roomId === "string" ? message.roomId : runtime.agentId;

				// Multi-turn follow-up: choice reply for an in-progress create flow.
				if (isChoiceReply(text)) {
					if (await hasPendingViewsCreateIntent(runtime, roomId)) {
						const views = await client.listViews();
						return runViewsCreate({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}
				}

				// Multi-turn follow-up: yes/no for a pending delete confirmation.
				if (isDeleteConfirmation(text) || isDeleteCancellation(text)) {
					if (await hasPendingDeleteConfirm(runtime, roomId)) {
						const views = await client.listViews();
						return runViewsDelete({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}
				}

				const mode = inferMode(text, actionOptions);
				const viewType = readViewTypeOption(text, actionOptions);
				if (!mode) {
					const reply =
						'Tell me what to do with views. Try: "list views", "open wallet view", "create a new view", or "delete the LifeOps plugin".';
					await callback?.({ text: reply });
					return { success: false, text: reply };
				}

				let effectiveMode = mode;
				let prefetchedViews: ViewSummary[] | null = null;
				let prefetchedCurrentView:
					| Awaited<ReturnType<ViewsClient["getCurrentView"]>>
					| null
					| undefined;
				let forcedResolvedCapability: ResolvedViewCapability | null = null;
				const getViews = async () => {
					prefetchedViews ??= await client.listViews();
					return prefetchedViews;
				};
				const getCurrentView = async () => {
					prefetchedCurrentView ??= await client
						.getCurrentView()
						.catch(() => null);
					return prefetchedCurrentView;
				};

				if (effectiveMode === "interact") {
					const views = await getViews().catch(() => []);
					effectiveMode =
						preferLayoutModeOverCapability({
							text,
							options: actionOptions,
							views,
						}) ?? effectiveMode;
				}

				if (shouldResolveModeAsCapability(effectiveMode, text, actionOptions)) {
					const views = await getViews().catch(() => []);
					const currentView = await getCurrentView();
					forcedResolvedCapability = resolveViewCapability({
						views,
						text,
						options: actionOptions,
						viewType,
						currentViewId: currentView?.viewId,
					});
					if (forcedResolvedCapability) {
						effectiveMode = "interact";
					}
				}

				logger.info(`[plugin-app-control] VIEWS mode=${effectiveMode}`);

				switch (effectiveMode) {
					case "list":
						return runViewsList({ client, viewType, callback });

					case "current": {
						const currentView = await client.getCurrentView();
						const resultText = currentView
							? `Current view: ${currentView.viewLabel} (${currentView.viewType}) — ${currentView.viewId}${currentView.viewPath ? ` at ${currentView.viewPath}` : ""}.`
							: "No current view has been reported yet.";
						await callback?.({ text: resultText });
						return {
							success: true,
							text: resultText,
							values: {
								mode: "current",
								viewId: currentView?.viewId,
								viewType: currentView?.viewType,
							},
							data: { currentView },
						};
					}

					case "show":
					case "open":
						return runViewsShow({
							client,
							message,
							options: actionOptions,
							viewType,
							callback,
						});

					case "close":
						return runViewsClose({
							client,
							message,
							options: actionOptions,
							viewType,
							callback,
						});

					case "search": {
						const query = extractSearchQuery(text, actionOptions);
						return runViewsSearch({ client, query, viewType, callback });
					}

					case "manager": {
						const managerView = {
							id: "__view-manager__",
							label: "View Manager",
							path: "/views",
							pluginName: "core",
							available: true,
						};
						const resultText = await navigateToPath(
							managerView.path,
							managerView.label,
						);
						await callback?.({ text: resultText });
						return {
							success: true,
							text: resultText,
							values: { mode: "manager" },
							data: { view: managerView },
						};
					}

					case "broadcast": {
						const eventType =
							readStringOption(actionOptions, "eventType") ??
							readStringOption(actionOptions, "event") ??
							readStringOption(actionOptions, "type");
						if (!eventType) {
							const reply =
								"Specify an event type to broadcast, e.g. action=broadcast eventType=wallet:refresh.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						const payload =
							actionOptions?.payload !== null &&
							typeof actionOptions?.payload === "object" &&
							!Array.isArray(actionOptions?.payload)
								? (actionOptions.payload as Record<string, unknown>)
								: {};
						const resultText = await broadcastViewEvent(eventType, payload);
						await callback?.({ text: resultText });
						return {
							success: true,
							text: resultText,
							values: { mode: "broadcast", eventType },
							data: { eventType, payload },
						};
					}

					case "interact": {
						let viewId =
							readStringOption(actionOptions, "view") ??
							readStringOption(actionOptions, "viewId") ??
							readStringOption(actionOptions, "id") ??
							readStringOption(actionOptions, "name") ??
							readStringOption(actionOptions, "target");
						let capability = readStringOption(actionOptions, "capability");
						let resolvedViewType = viewType;
						const views = await getViews().catch(() => []);
						if (!viewId && /\bcurrent\b/i.test(text)) {
							const currentView = await getCurrentView();
							viewId = currentView?.viewId ?? null;
							resolvedViewType = viewType ?? currentView?.viewType;
						}
						const currentViewForResolution =
							!viewId && !forcedResolvedCapability
								? await getCurrentView()
								: null;
						let resolvedCapability =
							forcedResolvedCapability ??
							resolveViewCapability({
								views,
								text,
								options: actionOptions,
								viewType,
								currentViewId: viewId ?? currentViewForResolution?.viewId,
							});
						if (!resolvedCapability && (!viewId || !capability)) {
							const currentView = await getCurrentView();
							resolvedCapability = resolveViewCapability({
								views,
								text,
								options: actionOptions,
								viewType,
								currentViewId: currentView?.viewId,
							});
							if (!viewId && currentView?.viewId) {
								resolvedViewType = viewType ?? currentView.viewType;
							}
						}
						if (resolvedCapability) {
							viewId = resolvedCapability.view.id;
							capability = resolvedCapability.capability.id;
							resolvedViewType = viewType ?? resolvedCapability.view.viewType;
						} else if (viewId) {
							const resolved = resolveViewTarget(viewId, views);
							if (resolved) {
								viewId = resolved.id;
								resolvedViewType = viewType ?? resolved.viewType;
							}
						}
						if (!viewId || !capability) {
							const reply =
								"Specify view and capability, e.g. action=interact view=wallet capability=get-state, or ask for the current view after navigating.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						const params = readCapabilityParams(
							actionOptions,
							resolvedCapability?.capability,
							resolvedCapability?.view,
							text,
						);
						const timeoutMs =
							typeof actionOptions?.timeoutMs === "number" &&
							actionOptions.timeoutMs > 0
								? actionOptions.timeoutMs
								: 5_000;
						const interaction = await interactWithView(
							viewId,
							capability,
							params,
							timeoutMs,
							resolvedViewType,
						);
						const resultText = interaction.text;
						await callback?.({ text: resultText });
						return {
							success: interaction.success,
							text: resultText,
							values: {
								mode: "interact",
								viewId,
								viewType: resolvedViewType ?? "gui",
								capability,
							},
							data: {
								viewId,
								viewType: resolvedViewType ?? "gui",
								capability,
								params,
							},
						};
					}

					case "create": {
						const views = await client.listViews();
						return runViewsCreate({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "edit": {
						const views = await client.listViews();
						return runViewsEdit({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "delete":
					case "remove": {
						const views = await client.listViews();
						return runViewsDelete({
							runtime,
							message,
							options: actionOptions,
							views,
							callback,
							repoRoot: getRepoRoot(),
						});
					}

					case "pin": {
						const resolution = await resolveSingleShellTargetView({
							client,
							text,
							options: actionOptions,
							viewType,
						});
						if (resolution.kind === "none") {
							const reply =
								"Specify which view to pin as a desktop tab, e.g. action=pin view=wallet.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						if (resolution.kind === "ambiguous") {
							const list = resolution.candidates
								.map((view) => `- ${view.label} (${view.id})`)
								.join("\n");
							const reply = `That matches multiple views:\n${list}\nWhich one should I pin?`;
							await callback?.({ text: reply });
							return {
								success: false,
								text: reply,
								data: { candidates: resolution.candidates },
							};
						}
						const pinView = resolution.view;
						const resolvedViewType =
							readExplicitViewTypeOption(options) ??
							viewType ??
							pinView.viewType ??
							(await resolveViewTypeForId(client, pinView.id));
						const pinResultText = await pinViewAsTab(
							pinView.id,
							resolvedViewType === "gui" ? undefined : resolvedViewType,
						);
						await callback?.({ text: pinResultText });
						return {
							success: true,
							text: pinResultText,
							values: {
								mode: "pin",
								viewId: pinView.id,
								viewType: resolvedViewType ?? "gui",
							},
							data: { viewId: pinView.id, viewType: resolvedViewType ?? "gui" },
						};
					}

					case "window": {
						const resolution = await resolveSingleShellTargetView({
							client,
							text,
							options: actionOptions,
							viewType,
						});
						const alwaysOnTop = readBooleanOption(actionOptions, "alwaysOnTop");
						if (resolution.kind === "none") {
							const reply =
								"Specify which view to open in a new window, e.g. action=window view=wallet.";
							await callback?.({ text: reply });
							return { success: false, text: reply };
						}
						if (resolution.kind === "ambiguous") {
							const list = resolution.candidates
								.map((view) => `- ${view.label} (${view.id})`)
								.join("\n");
							const reply = `That matches multiple views:\n${list}\nWhich one should I open in a new window?`;
							await callback?.({ text: reply });
							return {
								success: false,
								text: reply,
								data: { candidates: resolution.candidates },
							};
						}
						const windowView = resolution.view;
						const resolvedViewType =
							readExplicitViewTypeOption(options) ??
							viewType ??
							windowView.viewType ??
							(await resolveViewTypeForId(client, windowView.id));
						const windowResultText = await openViewInWindow(
							windowView.id,
							resolvedViewType === "gui" ? undefined : resolvedViewType,
							alwaysOnTop,
						);
						await callback?.({ text: windowResultText });
						return {
							success: true,
							text: windowResultText,
							values: {
								mode: "window",
								viewId: windowView.id,
								viewType: resolvedViewType ?? "gui",
								alwaysOnTop,
							},
							data: {
								viewId: windowView.id,
								viewType: resolvedViewType ?? "gui",
								alwaysOnTop,
							},
						};
					}

					case "split":
					case "tile":
						return runViewsLayout({
							client,
							message,
							mode: effectiveMode,
							options: actionOptions,
							viewType,
							callback,
						});
				}
			};

			return withViewsUserFacingText(await run());
		},

		examples: [
			[
				{
					name: "{{user1}}",
					content: { text: "list views" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "available_views:\n  count: 3\nviews[3]{id,label,path,available}:\n  wallet.inventory,Wallet,/wallet,yes\n  chat,Chat,/,yes\n  settings,Settings,/settings,yes",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to Wallet.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "search views finance" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Views matching "finance" (1):\n  [60] Wallet (wallet.inventory) — /wallet — Track your crypto balances.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "open view manager" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Navigated to View Manager.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "split notes and calendar side by side" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Split views: Notes, Calendar (horizontal).",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "tile notes calendar and trajectories" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Tiled views: Notes, Calendar, Trajectories.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "tell the wallet view to refresh" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Broadcast view event "wallet:refresh" to all connected views.',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "get the state of the settings view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Interacted with view "settings" — capability "get-state" (returned theme and language).',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: {
						text: "create a sticky note titled launch checklist with body test auth and billing",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Created note "launch checklist".',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "show my notes" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "1 note.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: {
						text: "add a calendar event titled team sync on 2026-06-08 at 17:00",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Created event "team sync".',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: {
						text: "tomorrow is my birthday can you add that to calendar",
					},
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Created event "Birthday".',
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "show calendar events for 2026-06-08" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "1 event on 2026-06-08.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "create a new view for tracking habits" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "[CHOICE:views-create id=views-create-…]\nnew = Create a new view plugin\ncancel = Cancel\n[/CHOICE]",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "edit the wallet view" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: "Started view edit task for Wallet at /…/plugins/plugin-wallet. Task session abc123 is running.",
						action: "VIEWS",
					},
				},
			],
			[
				{
					name: "{{user1}}",
					content: { text: "delete the LifeOps plugin" },
				},
				{
					name: "{{agentName}}",
					content: {
						text: 'Are you sure you want to delete the LifeOps view (@elizaos/plugin-personal-assistant)? Reply "yes" to confirm or "cancel" to abort.',
						action: "VIEWS",
					},
				},
			],
		],
	};
}

export function createViewsAliasAction(
	name: "CLOSE_VIEW" | "CLOSE_ALL_VIEWS",
	deps: ViewsActionDeps = {},
): Action {
	const action = createViewsAction(deps);
	const closeAll = name === "CLOSE_ALL_VIEWS";
	return {
		...action,
		name,
		similes: closeAll
			? ["CLOSE_ALL_VIEW_TABS", "HIDE_ALL_VIEWS", "DISMISS_ALL_VIEWS"]
			: ["HIDE_VIEW", "DISMISS_VIEW", "CLOSE_PANEL", "CLOSE_APP_VIEW"],
		description: closeAll
			? "Close or hide all currently open UI views/tabs without deleting plugins."
			: "Close or hide one UI view/tab without deleting its plugin. Accepts view, id, name, or target.",
		descriptionCompressed: closeAll
			? "close all open UI views/tabs; never deletes plugins"
			: "close one UI view/tab by view/id/name/target; never deletes plugins",
		handler: async (runtime, message, state, options, callback) => {
			const actionOptions = {
				...normalizeActionOptions(options),
				action: "close",
				mode: "close",
				...(closeAll ? { all: true, target: "__all__" } : {}),
			};
			return action.handler(runtime, message, state, actionOptions, callback);
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the agent is running on a platform that prohibits dynamic
 * code loading (iOS App Store and Google Play builds).
 */
export function isRestrictedPlatform(): boolean {
	const variant = (process.env.ELIZA_BUILD_VARIANT ?? "").trim().toLowerCase();
	if (variant === "store") return true;
	const platform = (process.env.ELIZA_PLATFORM ?? "").trim().toLowerCase();
	return platform === "ios" || platform === "android";
}

async function navigateToPath(pathStr: string, label: string): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(`${base}/api/views/__view-manager__/navigate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: pathStr }),
			signal: AbortSignal.timeout(5_000),
		});
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return `Navigated to ${label}.`;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/manager navigate returned ${resp.status}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Opened ${label} at ${pathStr}.`;
}

async function navigateViewWithShellAction(
	viewId: string,
	action: "pin-tab" | "open-window" | "close" | "close-all",
	successText: string,
	fallbackText: string,
	viewType?: ViewType,
	alwaysOnTop = false,
): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, viewType, alwaysOnTop }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return successText;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate returned ${resp.status}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return fallbackText;
}

async function navigateViewLayout({
	viewId,
	action,
	viewIds,
	layout,
	placement,
	viewType,
	successText,
	fallbackText,
}: {
	viewId: string;
	action: "split-view" | "tile-views";
	viewIds: string[];
	layout: "horizontal" | "vertical" | "grid";
	placement?: "left" | "right" | "top" | "bottom";
	viewType?: ViewType;
	successText: string;
	fallbackText: string;
}): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/navigate${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					action,
					views: viewIds,
					layout,
					...(placement ? { placement } : {}),
					...(viewType ? { viewType } : {}),
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (resp.ok || resp.status === 501 || resp.status === 404) {
			return successText;
		}
		logger.warn(
			`[plugin-app-control] VIEWS/${action} navigate returned ${resp.status}`,
		);
	} catch {
		// Network or timeout — not fatal.
	}

	return fallbackText;
}

function pinViewAsTab(viewId: string, viewType?: ViewType): Promise<string> {
	return navigateViewWithShellAction(
		viewId,
		"pin-tab",
		`Pinned ${viewType ?? "gui"} view "${viewId}" as a desktop tab.`,
		`Requested desktop tab pin for ${viewType ?? "gui"} view "${viewId}".`,
		viewType,
	);
}

function openViewInWindow(
	viewId: string,
	viewType?: ViewType,
	alwaysOnTop = false,
): Promise<string> {
	return navigateViewWithShellAction(
		viewId,
		"open-window",
		`Opened ${viewType ?? "gui"} view "${viewId}" in a separate window.`,
		`Requested separate window for ${viewType ?? "gui"} view "${viewId}".`,
		viewType,
		alwaysOnTop,
	);
}

/**
 * POST /api/views/:id/interact — invoke a capability on a mounted view and
 * return the result. Waits up to timeoutMs for the frontend to respond.
 */
async function interactWithView(
	viewId: string,
	capability: string,
	params: Record<string, unknown> | undefined,
	timeoutMs: number,
	viewType?: ViewType,
): Promise<{ success: boolean; text: string; result?: unknown }> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	let resp: Response;
	try {
		resp = await fetch(
			`${base}/api/views/${encodeURIComponent(viewId)}/interact${viewType ? `?viewType=${viewType}` : ""}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ capability, params, timeoutMs, viewType }),
				signal: AbortSignal.timeout(timeoutMs + 1_000),
			},
		);
	} catch (err) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact network error: ${err instanceof Error ? err.message : String(err)}`,
		);
		return {
			success: false,
			text: `Failed to interact with view "${viewId}": network error.`,
		};
	}

	if (resp.status === 504) {
		return {
			success: false,
			text: `View "${viewId}" did not respond to capability "${capability}" within ${timeoutMs}ms.`,
		};
	}
	if (resp.status === 404) {
		return {
			success: false,
			text: `View "${viewId}" not found or not mounted.`,
		};
	}
	if (resp.status === 400) {
		let detail = "";
		try {
			const body = (await resp.json()) as Record<string, unknown>;
			detail = typeof body.error === "string" ? ` — ${body.error}` : "";
		} catch {
			/* ignore */
		}
		return {
			success: false,
			text: `Cannot invoke capability "${capability}" on view "${viewId}"${detail}.`,
		};
	}
	if (!resp.ok) {
		logger.warn(
			`[plugin-app-control] VIEWS/interact returned ${resp.status} for view "${viewId}"`,
		);
		return {
			success: false,
			text: `Interact with view "${viewId}" failed (HTTP ${resp.status}).`,
		};
	}

	let result: unknown;
	try {
		result = await resp.json();
	} catch {
		return {
			success: true,
			text: `Interacted with view "${viewId}" (capability "${capability}") — no parseable result.`,
		};
	}

	const text = textFromInteractionResult(result);
	const success = successFromInteractionResult(result);
	if (text) return { success, text, result };

	return {
		success,
		text: `Interacted with view "${viewId}" — capability "${capability}" (${summarizeInteractionResult(result)}).`,
		result,
	};
}

function summarizeInteractionResult(result: unknown): string {
	if (Array.isArray(result)) {
		return `returned ${result.length} item${result.length === 1 ? "" : "s"}`;
	}
	if (!result || typeof result !== "object") {
		return "completed with no additional details";
	}
	const record = result as Record<string, unknown>;
	const payload =
		record.result &&
		typeof record.result === "object" &&
		!Array.isArray(record.result)
			? (record.result as Record<string, unknown>)
			: record;
	const keys = Object.keys(payload).filter(
		(key) => key !== "success" && key !== "text",
	);
	if (keys.length === 0) return "completed with structured result";
	const shown = keys.slice(0, 4).join(", ");
	const suffix = keys.length > 4 ? `, and ${keys.length - 4} more` : "";
	return `returned ${shown}${suffix}`;
}

function textFromInteractionResult(result: unknown): string | null {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const record = result as Record<string, unknown>;
	if (typeof record.text === "string" && record.text.trim()) {
		return record.text.trim();
	}
	const nested = record.result;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const nestedText = (nested as Record<string, unknown>).text;
		if (typeof nestedText === "string" && nestedText.trim()) {
			return nestedText.trim();
		}
	}
	return null;
}

function successFromInteractionResult(result: unknown): boolean {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return true;
	const record = result as Record<string, unknown>;
	if (typeof record.success === "boolean") return record.success;
	const nested = record.result;
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		const nestedSuccess = (nested as Record<string, unknown>).success;
		if (typeof nestedSuccess === "boolean") return nestedSuccess;
	}
	return true;
}

/**
 * POST /api/views/events/broadcast — push a view event to all connected
 * frontend tabs via the server's WebSocket broadcast.
 */
async function broadcastViewEvent(
	eventType: string,
	payload: Record<string, unknown>,
): Promise<string> {
	const { resolveServerOnlyPort } = await import("@elizaos/core");
	const port = resolveServerOnlyPort(process.env);
	const base = `http://127.0.0.1:${port}`;

	try {
		const resp = await fetch(`${base}/api/views/events/broadcast`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ type: eventType, payload }),
			signal: AbortSignal.timeout(5_000),
		});
		if (resp.ok) {
			return `Broadcast view event "${eventType}" to all connected views.`;
		}
		logger.warn(`[plugin-app-control] VIEWS/broadcast returned ${resp.status}`);
	} catch {
		// Network or timeout — not fatal.
	}

	return `Attempted to broadcast view event "${eventType}".`;
}

export const viewsAction: Action = createViewsAction();
export const closeViewAction: Action = createViewsAliasAction("CLOSE_VIEW");
export const closeAllViewsAction: Action =
	createViewsAliasAction("CLOSE_ALL_VIEWS");
