/**
 * The `Plugin` contract itself: the object a plugin's `src/index.ts` exports,
 * aggregating its actions, providers, evaluators, services, models, routes,
 * events, and schema. The top-level unit the agent's plugin loader resolves,
 * validates, and wires into the runtime.
 */
import type { AppPackageRouteContext } from "../api/route-helpers";
import type { ConnectorSourceDefinition } from "../connectors";
import type { ResponseHandlerEvaluator } from "../runtime/response-handler-evaluators";
import type { ResponseHandlerFieldEvaluator } from "../runtime/response-handler-field-evaluator";
import type { Character } from "./agent";
import type { ChatPreHandler } from "./chat-pre-handler";
import type { Action, AgentContext, Provider } from "./components";
import type { IDatabaseAdapter } from "./database";
import type { RegisteredEvaluator } from "./evaluator";
import type { EventHandler, EventPayload, EventPayloadMap } from "./events";
import type {
	ModelParamsMap,
	ModelRegistrationMetadata,
	PluginModelResult,
} from "./model";
import type { X402Config, X402RequestValidator } from "./payment";
import type { JsonValue, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { Service } from "./service";
import type { ShortcutDefinition } from "./shortcut";
import type { TestSuite } from "./testing";
import type { ViewKind } from "./view-kind";

export type RouteRuntimeMode = "local" | "local-only" | "cloud" | "remote";

/**
 * Type for a service class constructor.
 * This is more flexible than `typeof Service` to allow for:
 * - Service classes with more specific `serviceType` values (e.g., "task" instead of string)
 * - Service classes that properly extend the base Service class
 */
export interface ServiceClass {
	/** The service type identifier */
	serviceType: string;
	/** True when multiple implementations may intentionally share this service type. */
	allowsMultiple?: boolean;
	/** Factory method to create and start the service */
	start(runtime: IAgentRuntime): Promise<Service>;
	/** Stop service for a runtime - optional as not all services implement this */
	stopRuntime?(runtime: IAgentRuntime): Promise<void>;
	/** Optional static method to register send handlers */
	registerSendHandlers?(runtime: IAgentRuntime, service: Service): void;
	/** Constructor (optional runtime parameter) */
	new (runtime?: IAgentRuntime): Service;
}

/**
 * Supported types for route request body fields
 */
export type RouteBodyValue = JsonValue;

/**
 * Minimal request interface
 * Plugins can use this type for route handlers
 */
export interface RouteRequest {
	body?: Record<string, RouteBodyValue>;
	/** Raw UTF-8 body bytes (required for webhook HMAC verification). */
	rawBody?: string;
	params?: Record<string, string>;
	query?: Record<string, string | string[]>;
	headers?: Record<string, string | string[] | undefined>;
	method?: string;
	path?: string;
	url?: string;
}

/**
 * Minimal response interface
 * Plugins can use this type for route handlers
 */
export interface RouteResponse {
	status: (code: number) => RouteResponse;
	json: (data: unknown) => RouteResponse;
	send: (data: unknown) => RouteResponse;
	end: () => RouteResponse;
	setHeader?: (name: string, value: string | string[]) => RouteResponse;
	sendFile?: (path: string) => RouteResponse;
	headersSent?: boolean;
}

/**
 * Context passed to the return-shape route handler ({@link RouteHandler}).
 *
 * This is the canonical contract used by `dispatchRoute` for both HTTP and
 * in-process (IPC) invocations. The legacy Express-shaped `handler` field on
 * {@link Route} remains supported during the plugin-route migration; new
 * plugin routes should prefer `routeHandler` returning a
 * {@link RouteHandlerResult}.
 */
export interface RouteHandlerContext {
	body: unknown;
	/** Raw UTF-8 body when the transport preserved it (webhook signature verification). */
	rawBody?: string;
	params: Record<string, string>;
	query: Record<string, string | string[]>;
	headers: Record<string, string>;
	method: string;
	path: string;
	runtime: IAgentRuntime;
	/** true when invoked in-process via IPC; false when invoked over HTTP. */
	inProcess: boolean;
	/** true when the HTTP transport has verified this request as loopback/local. */
	isTrustedLocal?: boolean;
}

/** Return-shape result produced by a {@link RouteHandler}. */
export interface RouteHandlerResult {
	status: number;
	headers?: Record<string, string>;
	/** JSON-serializable body; the adapter stringifies on the way out. */
	body?: unknown;
	/** Optional streaming body for SSE / long responses. */
	stream?: AsyncIterable<Uint8Array | string>;
}

/** Canonical, return-shape route handler. */
export type RouteHandler = (
	ctx: RouteHandlerContext,
) => Promise<RouteHandlerResult>;

/** Express-shaped legacy route handler. */
export type LegacyRouteHandler = (
	req: RouteRequest,
	res: RouteResponse,
	runtime: IAgentRuntime,
) => Promise<void>;

interface BaseRoute {
	type: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
	path: string;
	filePath?: string;
	/** Legacy Express-shaped handler. Coexists with `routeHandler` during migration. */
	handler?: LegacyRouteHandler;
	/** Canonical return-shape handler used by `dispatchRoute`. */
	routeHandler?: RouteHandler;
	isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
	/**
	 * When true, the route path is used as-is without the plugin-name prefix.
	 * Use for legacy API paths that must remain stable (e.g. `/api/telegram-setup/status`).
	 */
	rawPath?: boolean;
	/**
	 * Runtime modes where this route is visible. The agent HTTP server hides
	 * routes outside this list with 404 before handler logic runs
	 * (packages/agent/src/api/runtime-mode/), so every host — the bare agent
	 * and the app-core wrapper — enforces the same visibility contract.
	 */
	modes?: ReadonlyArray<RouteRuntimeMode>;
	/** Free-form one-liner documenting why the route is scoped to those modes. */
	modeReason?: string;
	/** x402 micropayment gate: object, or `true` to use `character.settings.x402` defaults */
	x402?: X402Config | true;
	/** Runs before payment; invalid → 402 with accepts payload */
	validator?: X402RequestValidator;
	/** Optional OpenAPI-style metadata for x402 outputSchema */
	openapi?: {
		parameters?: Array<{
			name: string;
			in: "path" | "query" | "header";
			required?: boolean;
			description?: string;
			schema: {
				type: string;
				format?: string;
				pattern?: string;
				enum?: string[];
				minimum?: number;
				maximum?: number;
			};
		}>;
		requestBody?: {
			required?: boolean;
			description?: string;
			content: {
				"application/json"?: { schema: JsonValue };
				"multipart/form-data"?: { schema: JsonValue };
			};
		};
	};
	/** Shown in x402 `accepts` / wallet UIs when set */
	description?: string;
}

interface PublicRoute extends BaseRoute {
	public: true;
	name: string; // Name is required for public routes
	/**
	 * Reviewed reason this route may bypass the central auth gate.
	 * Public routes without this intent are rejected by route registration and
	 * dispatchers.
	 */
	publicReason: string;
	/**
	 * A public route is unauthenticated by the central gate, so it defaults to
	 * read-only (`GET`/`STATIC`): defense-in-depth against a mutating endpoint
	 * being shipped world-reachable. A non-GET public route (an inbound webhook,
	 * an OAuth redirect exchange, a companion-bridge callback) is authenticated
	 * out-of-band instead of by the gate, so it must opt in here by naming that
	 * mechanism (signature check, unguessable capability token, …). Without this,
	 * a `public: true` route with a write method is rejected at registration and
	 * dispatch. GET/STATIC public routes never need it.
	 */
	publicWrite?: string;
}

interface PrivateRoute extends BaseRoute {
	public?: false;
	name?: string; // Name is optional for private routes
}

export type Route = PublicRoute | PrivateRoute;

/** Write methods a public route may only use when it self-authenticates. */
const PUBLIC_WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function assertPublicRouteIntent(route: Route, source = "plugin"): void {
	if (route.public !== true) return;
	const reason = (route as { publicReason?: unknown }).publicReason;
	if (typeof reason !== "string" || reason.trim().length === 0) {
		throw new Error(
			`[RouteAuth] Public route ${source}:${route.type} ${route.path} must declare publicReason`,
		);
	}
	if (PUBLIC_WRITE_METHODS.has(route.type)) {
		const publicWrite = (route as { publicWrite?: unknown }).publicWrite;
		if (typeof publicWrite !== "string" || publicWrite.trim().length === 0) {
			throw new Error(
				`[RouteAuth] Public ${route.type} route ${source}:${route.path} is unauthenticated by the central gate; a write-method public route must declare publicWrite naming its out-of-band auth (signature, capability token, …). Make it GET, gate it, or declare publicWrite.`,
			);
		}
	}
}

/** Route that may include x402 payment fields (alias for authoring clarity) */
export type PaymentEnabledRoute = Route;

/**
 * JSON Schema type definition for component validation
 */
export interface JSONSchemaDefinition {
	type: string;
	properties?: { [key: string]: JSONSchemaDefinition };
	items?: JSONSchemaDefinition;
	required?: string[];
	enumValues?: string[];
	description?: string;
}

/**
 * Component type definition for entity components
 */
export interface ComponentTypeDefinition {
	name: string;
	schema: JSONSchemaDefinition;
	validator?: (data: Record<string, RouteBodyValue>) => boolean;
}

/**
 * Plugin for extending agent functionality
 */

export type PluginEvents = {
	[K in keyof EventPayloadMap]?: EventHandler<K>[];
};

/** Internal type for runtime event storage - allows dynamic access for event registration */
export type RuntimeEventStorage = PluginEvents & {
	[key: string]:
		| ((
				params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
		  ) => Promise<void>)[]
		| undefined;
};

/**
 * Database adapter factory. When set on a plugin, this plugin provides the
 * database adapter. Called before runtime construction with agentId and basic-capabilities
 * settings (character + env, not DB). Only one plugin per character should set this.
 */
export type AdapterFactory = (
	agentId: UUID,
	settings: Record<string, string>,
) => IDatabaseAdapter | Promise<IDatabaseAdapter>;

export type PluginAppSessionMode = "viewer" | "spectate-and-steer" | "external";

export type PluginAppSessionFeature =
	| "commands"
	| "telemetry"
	| "pause"
	| "resume"
	| "suggestions";

export type PluginAppControlAction = "pause" | "resume";

export type PluginAppTelemetryValue =
	| JsonValue
	| PluginAppTelemetryValue[]
	| { [key: string]: PluginAppTelemetryValue };

export interface PluginAppViewer {
	url: string;
	embedParams?: Record<string, string>;
	postMessageAuth?: boolean;
	sandbox?: string;
}

export interface PluginAppViewerAuthMessage {
	type: string;
	authToken?: string;
	characterId?: string;
	sessionToken?: string;
	agentId?: string;
	followEntity?: string;
}

export interface PluginAppSession {
	mode: PluginAppSessionMode;
	features?: PluginAppSessionFeature[];
}

export interface PluginAppRecommendation {
	id: string;
	label: string;
	type?: string;
	reason?: string | null;
	priority?: number | null;
	command?: string | null;
}

export interface PluginAppActivityItem {
	id: string;
	type: string;
	message: string;
	timestamp?: number | null;
	severity?: "info" | "warning" | "error";
}

export interface PluginAppSessionState {
	sessionId: string;
	appName: string;
	mode: PluginAppSessionMode;
	status: string;
	displayName?: string;
	agentId?: string;
	characterId?: string;
	followEntity?: string;
	canSendCommands?: boolean;
	controls?: PluginAppControlAction[];
	summary?: string | null;
	goalLabel?: string | null;
	suggestedPrompts?: string[];
	recommendations?: PluginAppRecommendation[];
	activity?: PluginAppActivityItem[];
	telemetry?: Record<string, PluginAppTelemetryValue> | null;
}

export interface PluginAppLaunchDiagnostic {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
}

/**
 * A single prerequisite a plugin declares for its diagnostic card. The host
 * resolves runtime state and maps {@link key} to a satisfied boolean; the
 * plugin owns the human-readable {@link label}.
 */
export interface PluginDiagnosticPrerequisite {
	/** Stable key the host's status resolver maps to a satisfied boolean. */
	key: string;
	/** Human-readable label shown on the diagnostic card. */
	label: string;
}

/**
 * Static metadata a plugin contributes so the host can render its diagnostic
 * card without hardcoding the plugin's identity, config keys, tags, or
 * prerequisites. The host resolves the runtime-dynamic status (enabled,
 * capability, prerequisite satisfaction) separately and merges it with this
 * descriptor. Owning this here keeps a single source of truth: renaming a
 * config key changes the descriptor, not the host.
 */
export interface PluginDiagnosticDescriptor {
	id: string;
	name: string;
	description: string;
	tags: string[];
	envKey: string | null;
	category:
		| "ai-provider"
		| "connector"
		| "streaming"
		| "database"
		| "app"
		| "feature";
	source: "bundled" | "store";
	configKeys: string[];
	npmName: string;
	managementMode: "standard" | "core-optional";
	/** Config-allowlist entries that mean "this plugin is enabled". */
	aliases: string[];
	prerequisites: PluginDiagnosticPrerequisite[];
}

export interface PluginAppBridgeLaunchContext {
	appName?: string;
	launchUrl?: string | null;
	runtime?: IAgentRuntime | null;
	app?: PluginApp | null;
	viewer?:
		| (PluginAppViewer & {
				authMessage?: PluginAppViewerAuthMessage;
		  })
		| null;
}

export interface PluginAppBridgeRunContext
	extends PluginAppBridgeLaunchContext {
	runId?: string;
	session?: PluginAppSessionState | null;
}

export interface PluginAppLaunchPreparation {
	diagnostics?: PluginAppLaunchDiagnostic[];
	launchUrl?: string | null;
	viewer?: PluginAppViewer | null;
}

export interface PluginAppBridge {
	handleAppRoutes?: (ctx: AppPackageRouteContext) => Promise<boolean>;
	prepareLaunch?: (
		ctx: PluginAppBridgeLaunchContext,
	) => Promise<PluginAppLaunchPreparation | null>;
	resolveViewerAuthMessage?: (
		ctx: PluginAppBridgeLaunchContext,
	) => Promise<PluginAppViewerAuthMessage | null>;
	ensureRuntimeReady?: (ctx: PluginAppBridgeLaunchContext) => Promise<void>;
	collectLaunchDiagnostics?: (
		ctx: PluginAppBridgeRunContext,
	) => Promise<PluginAppLaunchDiagnostic[]>;
	resolveLaunchSession?: (
		ctx: PluginAppBridgeLaunchContext,
	) => Promise<PluginAppSessionState | null>;
	refreshRunSession?: (
		ctx: PluginAppBridgeRunContext,
	) => Promise<PluginAppSessionState | null>;
	/**
	 * Called when a specific app run is stopped (via the Stop button or
	 * `POST /api/apps/runs/:runId/stop`). Plugins should tear down any
	 * runId-scoped resources here: open WebSocket connections, game-loop
	 * timers, bot sessions, child processes, embedded servers, etc.
	 *
	 * Implementations should be idempotent — if the resource is already
	 * gone the hook should return quietly. Errors are logged but do not
	 * block the run removal from the app-manager registry.
	 */
	stopRun?: (ctx: PluginAppBridgeRunContext) => Promise<void>;
}

/**
 * How the app shell treats the screen background while a view is active.
 *
 * - `opaque` (default): the host paints a full-window theme background behind
 *   the view, covering status/home-indicator safe areas so the shared wallpaper
 *   cannot leak through.
 * - `shared`: the view intentionally sits on the same unified background used
 *   by Home/Launcher.
 */
export type AppShellBackgroundPolicy = "opaque" | "shared";

/**
 * A nav-tab declaration so an app/plugin can register its own page in the
 * shell's main navigation without app-core hard-coding it. Resolved by the
 * shell at startup from the loaded plugin's `app.navTabs` field.
 */
export interface PluginAppNavTab {
	/** Stable id, scoped to the owning plugin (e.g. "wallet.inventory"). */
	id: string;
	/** Display label in the tab bar / nav. */
	label: string;
	/** Lucide icon name. */
	icon?: string;
	/** Route path the tab links to (e.g. "/inventory"). */
	path: string;
	/**
	 * Optional shell tab id this route should activate when it is not the same
	 * as `id` (for example, an app-shell page that lives inside a built-in tab).
	 */
	tabAffinity?: string;
	/** Sort priority within the nav (lower = first). Default 100. */
	order?: number;
	/**
	 * If true, this tab is only visible when Developer Mode is enabled
	 * in Settings. Defaults to false. Equivalent to `viewKind: "developer"`.
	 */
	developerOnly?: boolean;
	/**
	 * Four-tier visibility category. When set it supersedes `developerOnly`:
	 * `system`/`release` are always shown, `developer`/`preview` follow their
	 * Settings toggles. Omit to fall back to `developerOnly` → `release`.
	 */
	viewKind?: ViewKind;
	/**
	 * Optional named group the tab belongs to (used by the shell to render
	 * grouped tab strips, e.g. workbench/dev/wallet groupings).
	 */
	group?: string;
	/** Screen background policy for this tab. Defaults to `"opaque"`. */
	backgroundPolicy?: AppShellBackgroundPolicy;
	/**
	 * Optional package export specifier the shell will dynamically import
	 * when the tab is activated, e.g. "@elizaos/plugin-wallet-ui#InventoryView".
	 * The string before `#` is the package subpath, after `#` is the named
	 * export. When omitted, the shell falls back to the static component
	 * registry keyed by `id`.
	 */
	componentExport?: string;
}

/**
 * Serializable widget metadata declared by a plugin. Mirrors the
 * client-side type in `@elizaos/app-core/widgets` but lives here so plugins
 * can self-declare without depending on app-core.
 */
export const PLUGIN_WIDGET_SLOTS = [
	"chat-sidebar",
	"character",
	"nav-page",
	"home",
] as const;

export type PluginWidgetSlot = (typeof PLUGIN_WIDGET_SLOTS)[number];

export interface PluginWidgetDeclaration {
	/** Unique within the owning plugin, e.g. "lifeops-overview". */
	id: string;
	/** Owning plugin ID. */
	pluginId: string;
	/** Where this widget renders. */
	slot: PluginWidgetSlot;
	/** Human-readable label. */
	label: string;
	/** Lucide icon name. */
	icon?: string;
	/** Sort priority within the slot (lower = first). Default 100. */
	order?: number;
	/** Show by default when plugin is active. Default true. */
	defaultEnabled?: boolean;
	/** For nav-page slot: which header TabGroup to join. */
	navGroup?: string;
	/**
	 * If true, this widget is only visible when Developer Mode is enabled
	 * in Settings. Defaults to false. Equivalent to `viewKind: "developer"`.
	 */
	developerOnly?: boolean;
	/**
	 * Four-tier visibility category. Supersedes `developerOnly` when set.
	 * See {@link ViewKind}.
	 */
	viewKind?: ViewKind;
	/**
	 * Optional package export specifier the shell will dynamically import
	 * when rendering. Format: "<package-subpath>#<named-export>".
	 */
	componentExport?: string;
	/**
	 * Opt-in shared "default" widget sink for the `home` slot (#9143). A plugin
	 * that has live state but no bundled React component of its own sets this to
	 * surface that state through one of the shared frontpage widgets instead of
	 * shipping a component. Ignored unless `slot` is `"home"` and no own
	 * component is registered for this declaration's `pluginId`/`id`.
	 */
	defaultWidget?: "notifications" | "messages" | "activity";
	/**
	 * Home-slot attention signals this widget responds to (#9143 priority). When
	 * the home surface receives a live activity/notification signal of one of
	 * these kinds, this widget's importance is boosted (decayed by recency) so it
	 * bubbles up — that is how "what needs attention shows first" works. Kinds are
	 * the keys of the home signal-weight table (e.g. `blocked`, `escalation`,
	 * `approval`, `reminder`, `message`, `check-in`, `nudge`, `workflow`,
	 * `activity`). Omit for widgets that should rank by static `order` only.
	 */
	signalKinds?: readonly string[];
	/** Home-grid footprint (4-col grid). Default 2x1. */
	size?: { cols: number; rows: number };
	/**
	 * Visibility class for the built-in resolver (#12090 item 9). Drives
	 * `resolveWidgetsForSlot` visibility from the declaration instead of
	 * hardcoded plugin-id string sets, so a widget cannot drift out of the
	 * allow set (e.g. `todo` vs `todos`) when its plugin id changes.
	 *
	 * - `"always"` — a core surface with NO loadable plugin package
	 *   (notifications, welcome, needs-attention, feed, …). Renders regardless
	 *   of the runtime plugin snapshot; still hidden if an explicit
	 *   `present + disabled` snapshot entry exists for its plugin id.
	 * - `"fallback"` — backed by a store/compat data source, so it renders when
	 *   the snapshot is missing OR omits the plugin, but a `present + disabled`
	 *   entry hides it (agent-orchestrator, browser-workspace, todo).
	 * - `"snapshot"` / omitted — standard gate: visible only when the plugin is
	 *   enabled+active in the snapshot.
	 *
	 * Only honored for built-in declarations; server-provided declarations are
	 * always snapshot-gated regardless of this field.
	 */
	visibility?: "always" | "fallback" | "snapshot";
}

export interface PluginAppUiExtension {
	/** Detail panel id registered by the app's UI package. */
	detailPanelId?: string;
}

/** Platform availability for a view. */
export type ViewPlatform =
	| "web"
	| "desktop"
	| "ios"
	| "android"
	| "quest"
	| "xreal";

/** Presentation/runtime family for a view. */
export type ViewType = "gui" | "tui" | "xr";

/**
 * A surface a view renders on. Same set as {@link ViewType}; named separately
 * because a single view declaration can render on several modalities at once
 * (one component, drawn to GUI/XR DOM and TUI lines by `@elizaos/ui/spatial`).
 */
export type ViewModality = ViewType;

const MODALITY_ORDER: readonly ViewModality[] = ["gui", "xr", "tui"];

/** Order + de-duplicate a modality list as gui, xr, tui. */
export function dedupeModalities(
	mods: readonly ViewModality[],
): ViewModality[] {
	const seen = new Set(mods);
	return MODALITY_ORDER.filter((m) => seen.has(m));
}

/**
 * The surfaces a view declaration renders on: the explicit `modalities` list
 * when set, otherwise the single `viewType` (default "gui").
 */
export function getViewModalities(
	view: Pick<ViewDeclaration, "modalities" | "viewType">,
): ViewModality[] {
	if (view.modalities && view.modalities.length > 0) {
		return dedupeModalities(view.modalities);
	}
	return [view.viewType ?? "gui"];
}

/** A logical view: one entry per `id`, with every surface it renders on. */
export interface CollapsedView extends ViewDeclaration {
	/** Union of the surfaces this view renders on (across same-id declarations). */
	modalities: ViewModality[];
}

/**
 * Collapse view declarations to one entry per `id`, unioning the surfaces each
 * declaration supports. The "gui" declaration (clean label, no surface suffix)
 * is preferred as the canonical base. This is the single source the view
 * catalog and the modality hosts use so a view appears ONCE with modality
 * badges instead of one duplicate row per surface ("Phone" / "Phone XR" /
 * "Phone TUI").
 */
export function collapseViewDeclarations(
	views: readonly ViewDeclaration[],
): CollapsedView[] {
	const order: string[] = [];
	const byId = new Map<string, CollapsedView>();
	for (const view of views) {
		const mods = getViewModalities(view);
		const existing = byId.get(view.id);
		if (!existing) {
			order.push(view.id);
			byId.set(view.id, { ...view, modalities: mods });
			continue;
		}
		const merged = dedupeModalities([...existing.modalities, ...mods]);
		const isGui = (view.viewType ?? "gui") === "gui";
		const baseWasGui = (existing.viewType ?? "gui") === "gui";
		const base = isGui && !baseWasGui ? view : existing;
		byId.set(view.id, { ...base, modalities: merged });
	}
	return order.map((id) => byId.get(id) as CollapsedView);
}

/**
 * XR-specific panel options for a view rendered in a WebXR overlay.
 * All fields are optional and have sensible defaults for headset use.
 */
export interface XRViewOptions {
	/**
	 * Panel width in meters when rendered in world space.
	 * Defaults to 1.0 m (roughly a letter-size page at arm's length).
	 */
	defaultWidthMeters?: number;
	/**
	 * Panel height in meters. Defaults to 0.75 m.
	 */
	defaultHeightMeters?: number;
	/**
	 * How the panel follows the user's gaze / camera.
	 *  - "billboard"  — always faces the camera, orbits at fixed distance (default).
	 *  - "fixed"      — stays at its world-space transform once opened.
	 *  - "follow"     — smoothly lag-follows the camera without rotating.
	 */
	followMode?: "billboard" | "fixed" | "follow";
	/**
	 * Distance from the camera origin the panel is placed at (meters).
	 * Defaults to 1.5 m.
	 */
	defaultDistance?: number;
	/**
	 * Preferred initial position relative to the camera in meters [x, y, z].
	 * e.g. [0, 0, -1.5] is directly in front.
	 */
	defaultOffset?: [number, number, number];
	/**
	 * Whether this view supports voice input to its form fields.
	 * Defaults to true — app-xr will pipe Whisper transcripts to focused inputs.
	 */
	voiceInputEnabled?: boolean;
	/**
	 * Whether this view should render in the full overlay (true) or as a
	 * side panel / mini panel (false). Defaults to false.
	 */
	fullscreen?: boolean;
}

/** A discrete capability the agent can exercise on a mounted view. */
export interface ViewCapability {
	/** Unique id within the view (e.g. "click-button", "fill-input"). */
	id: string;
	/** Human-readable description surfaced to the planner. */
	description: string;
	/** JSON Schema for any parameters this capability accepts. */
	params?: Record<
		string,
		{ type: string; description: string; required?: boolean }
	>;
}

/**
 * A UI view contributed by a plugin.
 *
 * Views are compiled to JavaScript bundles, served by the agent router at
 * `/api/views/<id>/bundle.js`, and loaded dynamically by the frontend shell
 * via `import()`. On platforms where dynamic code loading is restricted (iOS
 * App Store, Google Play store builds), bundles are pre-compiled into the app
 * binary and the agent serves them from bundled assets — no remote download.
 *
 * The frontend shell:
 *   1. Fetches `GET /api/views` to discover all registered views.
 *   2. Calls `import(bundleUrl)` when a view is first requested.
 *   3. Mounts `module[componentExport ?? "default"]` in an error boundary.
 *   4. Calls the view's `cleanup()` export on unmount.
 */
export interface ViewDeclaration {
	/**
	 * Stable unique id scoped to the owning plugin (e.g. "wallet.inventory").
	 * Used as the URL segment: `/api/views/<id>/bundle.js`.
	 */
	id: string;
	/** Display label shown in the view manager and agent responses. */
	label: string;
	/**
	 * View presentation type. Defaults to `"gui"`.
	 *
	 * Plugins may register a `"tui"` declaration with the same `id` as a GUI
	 * declaration to override that view when the shell or agent requests TUI
	 * mode.
	 */
	viewType?: ViewType;
	/**
	 * Surfaces this single declaration renders on. Prefer one declaration with
	 * `modalities: ["gui", "xr", "tui"]` over duplicate per-`viewType`
	 * declarations sharing an `id`: the spatial renderer draws the one component
	 * to each surface (GUI/XR DOM, TUI lines) and the catalog lists the view
	 * once. When omitted, falls back to `[viewType ?? "gui"]`.
	 */
	modalities?: ViewModality[];
	/** One-line description used for semantic view search. */
	description?: string;
	/** Lucide icon name (e.g. "Wallet", "MessageSquare"). */
	icon?: string;
	/** URL path this view occupies in the shell (e.g. "/wallet"). */
	path?: string;
	/** Sort priority in the view manager — lower appears first. Default 100. */
	order?: number;
	/** Optional named group shared with app-shell page registrations. */
	group?: string;
	/** Tags for search and discovery (e.g. ["finance", "crypto"]). */
	tags?: string[];
	/**
	 * Runtime action names especially relevant while this view is foreground.
	 * Hosts use these as view-scoped affinity hints so plugins keep their own
	 * view -> action relationship with the view declaration.
	 */
	relatedActions?: string[];
	/**
	 * Optional free-form planner hints for this view.
	 */
	contextHints?: string[];
	/** Relative path from the plugin's package root to its hero image. */
	heroImagePath?: string;
	/** Screen background policy for this view. Defaults to `"opaque"`. */
	backgroundPolicy?: AppShellBackgroundPolicy;
	/**
	 * Platforms this view supports. Omit to support all platforms.
	 * Dynamic plugin install is disabled on restricted store builds (ios, android).
	 */
	platforms?: ViewPlatform[];
	/**
	 * Native device-OS surface that only exists on the AOSP ElizaOS fork (e.g.
	 * the phone dialer, messages, contacts, camera apps). When true the view is
	 * stripped from the routable view set on every non-AOSP build (web, desktop,
	 * iOS, stock Play-Store Android), matching the AOSP-gated home tiles. Hosts
	 * read this declared flag instead of hardcoding native-OS view ids. Default
	 * false.
	 */
	nativeOs?: boolean;
	/**
	 * Hidden unless developer mode is enabled. Default false. Equivalent to
	 * `viewKind: "developer"`.
	 */
	developerOnly?: boolean;
	/**
	 * Four-tier visibility category for this view. Supersedes `developerOnly`
	 * when set:
	 *  - `system`    — always shown (core shell views).
	 *  - `release`   — always shown (public, production-ready). The default.
	 *  - `developer` — shown when Developer views are enabled (dev builds on).
	 *  - `preview`   — shown when Preview views are enabled (off by default).
	 */
	viewKind?: ViewKind;
	/**
	 * Named export the shell mounts from the loaded bundle module.
	 * Defaults to `"default"`.
	 * Usage: `const mod = await import(bundleUrl); mount(mod[componentExport]);`
	 */
	componentExport?: string;
	/**
	 * Path from the plugin's package root to the compiled view bundle.
	 * Convention: `"dist/views/bundle.js"` or `"dist/views/<id>/bundle.js"`.
	 * The view registry resolves this to an absolute `/api/views/<id>/bundle.js`
	 * URL at startup and on plugin hot-reload.
	 */
	bundlePath?: string;
	/**
	 * Fully resolved compiled view bundle URL for remote capability modules.
	 * Local plugins should prefer `bundlePath`; remote plugins use this when
	 * the code is served by a sandbox/container rather than the agent process.
	 */
	bundleUrl?: string;
	/** Capabilities the agent can exercise on this view when it is mounted. */
	capabilities?: ViewCapability[];
	/**
	 * Optional backend capability handler for operations that do not require a
	 * mounted UI surface. The view route invokes this before falling back to the
	 * frontend `view:interact` WebSocket round-trip.
	 */
	serverInteract?: (
		capability: string,
		params?: Record<string, unknown>,
	) => Promise<unknown>;
	/** Allow this view to be pinned as a desktop tab. Default true. */
	desktopTabEnabled?: boolean;
	/** Show this view in the view manager grid. Default true. */
	visibleInManager?: boolean;
	/**
	 * When true, this view is an internal-tool app (plugin viewer, inspector,
	 * fine-tuning, automations) that the homescreen launcher may pin. The
	 * launcher builds its pinnable list from this declared flag instead of a
	 * hardcoded UI package-name table. Default false.
	 */
	pinnable?: boolean;
	/**
	 * XR-specific panel behaviour. Only meaningful when viewType === "xr".
	 * Omit to accept all defaults (1m-wide billboard panel at 1.5 m distance).
	 */
	xrOptions?: XRViewOptions;
}

export interface PluginApp {
	displayName?: string;
	category?: string;
	launchType?: string;
	launchUrl?: string | null;
	icon?: string | null;
	capabilities?: string[];
	minPlayers?: number | null;
	maxPlayers?: number | null;
	runtimePlugin?: string;
	viewer?: PluginAppViewer;
	session?: PluginAppSession;
	bridgeExport?: string;
	uiExtension?: PluginAppUiExtension;
	/**
	 * If true, the app is a developer-tooling surface (logs, trajectory
	 * viewer, etc.) and is hidden from the main UI unless Developer Mode is
	 * enabled in Settings. Defaults to false. Equivalent to
	 * `viewKind: "developer"`.
	 */
	developerOnly?: boolean;
	/**
	 * Four-tier visibility category for this app. Supersedes `developerOnly`
	 * when set. See {@link ViewKind}.
	 */
	viewKind?: ViewKind;
	/**
	 * Controls whether the app appears in the user-facing app store/catalog.
	 * Defaults to true. Set to false for apps that auto-install or are
	 * surfaced only via direct deep-links.
	 */
	visibleInAppStore?: boolean;
	/**
	 * Nav tabs this app contributes to the shell. The shell reads these at
	 * runtime so apps can register pages dynamically without app-core
	 * hard-coding them.
	 */
	navTabs?: PluginAppNavTab[];
}

export interface PluginEventRegistration {
	eventName: string;
	handler: (
		params: EventPayloadMap[keyof EventPayloadMap] | EventPayload,
	) => Promise<void> | void;
}

export interface PluginModelRegistration {
	modelType: string;
	handler: (
		runtime: IAgentRuntime,
		params: Record<string, JsonValue | object>,
	) => Promise<JsonValue | object>;
	metadata?: ModelRegistrationMetadata;
	provider: string;
}

export interface PluginServiceRegistration {
	serviceType: string;
	serviceClass: ServiceClass;
}

export interface PluginOwnership {
	pluginName: string;
	plugin: Plugin;
	registeredPlugin: Plugin | null;
	actions: Action[];
	providers: Provider[];
	evaluators: RegisteredEvaluator[];
	routes: Route[];
	events: PluginEventRegistration[];
	models: PluginModelRegistration[];
	services: PluginServiceRegistration[];
	shortcuts: string[];
	sendHandlerSources: string[];
	hasAdapter: boolean;
	registeredAt: number;
}

/**
 * Plugin execution mode.
 *
 * - `direct`: loaded in-process via `import` and registered with the runtime as
 *   a normal Plugin object. Trusted, full agent privilege, shared crash domain.
 *   This is the default for every existing plugin in the monorepo.
 * - `remote`: hosted by `RemotePluginHost` as a sandboxed Bun Worker (or
 *   isolated Bun process when `remote.isolation === "isolated-process"`).
 *   Communicates with the agent via the wire envelope defined in
 *   `@elizaos/plugin-remote-manifest`. Permissions are declared by the plugin
 *   and enforced by the host. Typically installed dynamically at runtime via
 *   `runtime.installRemotePlugin(...)` by an agent that has authored a plugin
 *   on the fly (e.g. a coding sub-agent).
 */
export type PluginMode = "direct" | "remote";

/**
 * High-level role of a remote-mode plugin. Used to classify the plugin and
 * to inform the `RuntimeCapabilityService` whether to surface the plugin as
 * a capability provider.
 */
export type RemotePluginRole =
	| "capability"
	| "sub-agent"
	| "view-host"
	| "system"
	| "user";

/**
 * Permission grants for a remote-mode plugin. The author declares the request
 * ceiling; the host narrows against (a) the agent's own granted permissions
 * and (b) the inline-source defaults for agent-authored plugins, taking the
 * intersection. A plugin runs with the *narrowed* grant, never with what it
 * requested verbatim.
 */
export interface RemotePluginPermissions {
	/** Bun runtime permissions inside the worker. */
	bun: {
		/** Outbound network policy. */
		network?: "none" | "loopback" | "allowlist" | "any";
		/** Host allowlist used when `network === "allowlist"`. */
		networkAllowlist?: string[];
		/** Filesystem access policy. */
		fs?: "none" | "readonly" | "readwrite";
		/** Filesystem path allowlist when `fs !== "none"`. */
		fsAllowlist?: string[];
		/** May spawn child processes (`Bun.spawn`, `child_process`). */
		process?: boolean;
		/** Environment variable names the worker may read. */
		env?: string[];
	};
	/** Host-side proxy permissions (what the worker can ask the runtime for). */
	host: {
		/** `runtime.getService(serviceType)` allowlist. Empty array = none. */
		services?: string[];
		/** `runtime.useModel(modelType, ...)` allowlist. */
		models?: string[];
		/** Event-name allowlist (both emit and listen). */
		events?: string[];
		/** Memory API access. */
		memory?: "none" | "read" | "readwrite";
	};
}

/**
 * Isolation strategy for the remote plugin worker.
 *
 * - `shared-worker`: a Bun `Worker` sharing the host process. Cheap, but a
 *   panic crashes the host. Use for trusted first-party plugins that need
 *   shared-memory access (e.g. GPU-backed local-model plugins).
 * - `isolated-process`: a separate Bun subprocess (`Bun.spawn`). The worker
 *   crashing only affects itself. Required for `role: "sub-agent"` and for
 *   any agent-authored plugin with `source.kind === "inline"`.
 */
export type RemotePluginIsolation = "shared-worker" | "isolated-process";

/**
 * Deployment-target constraints for a remote plugin. Declares where the
 * plugin is *allowed* to run; the actual target is inferred by the host at
 * install time based on which environments are reachable.
 */
export interface RemotePluginDeployment {
	/** Hint to the host. Default `"auto"`. */
	preferred?: "host" | "cloud" | "auto";
	/** Hard constraint on allowed deploy targets. Default `["host", "cloud"]`. */
	allowedTargets?: ("host" | "cloud")[];
	/**
	 * When `true`, the plugin must be hosted with `isolation: "isolated-process"`
	 * and cannot be downgraded to a `shared-worker`. Forced for `role: "sub-agent"`.
	 */
	requiresProcess?: boolean;
}

/**
 * Configuration block required when {@link Plugin.mode} is `"remote"`.
 * Describes how, where, and with what privileges the plugin's worker runs.
 */
export interface RemotePluginConfig {
	/** Classification for routing and discovery. */
	role?: RemotePluginRole;
	/** Permission request ceiling (narrowed by the host at install time). */
	permissions: RemotePluginPermissions;
	/** Worker isolation strategy. */
	isolation: RemotePluginIsolation;
	/** Path to the worker entrypoint, relative to the plugin package root. */
	worker: { relativePath: string };
	/** Optional view bundle entrypoint for plugins that contribute UI. */
	view?: { relativePath: string; hidden?: boolean };
	/** Deployment constraints. */
	deployment?: RemotePluginDeployment;
	/**
	 * Lifetime of the plugin installation.
	 * - `"session"`: uninstalled on runtime shutdown. Default for
	 *   `runtime.installRemotePlugin(...)`.
	 * - `"persistent"`: registration is written to the local plugin store and
	 *   re-installed on next boot.
	 */
	lifetime?: "session" | "persistent";
	/**
	 * Sub-agent runner configuration. Present iff `role === "sub-agent"`.
	 * Describes which coding-agent CLI the worker drives and how prompts are
	 * delivered to it.
	 */
	subAgent?: {
		runner: "claude-code" | "codex" | "opencode" | "eliza";
		promptInjection: "stdin-only" | "argv" | "env";
	};
	/**
	 * Optional explicit allowlist of host-callable RPC methods. When omitted,
	 * the announced surface (actions/providers/services/...) defines what's
	 * reachable.
	 */
	protocol?: { methods?: string[] };
}

/**
 * Source of the worker code for a remote-mode plugin installed at runtime
 * via {@link IAgentRuntime.installRemotePlugin}.
 *
 * - `inline`: agent-authored. The plugin's source files (typically the
 *   worker entry + a manifest) are handed over as a string map. The host
 *   writes them to a tempdir under `<stateDir>/remote-plugins/<runtime>/
 *   <pluginName>-<instanceId>/`, then spawns the worker from there. The
 *   inline path is intentionally restricted: workers run as
 *   `isolated-process` always, network defaults to `loopback`, and FS
 *   scopes to the tempdir, regardless of what the manifest requests.
 *
 * - `tarball`: third-party. Downloaded + verified by `attestation`
 *   (required for tarball installs; SHA + signature). Extracted into the
 *   store and treated like a normal install thereafter.
 *
 * - `workspace`: bundled. Resolves to an existing workspace package
 *   (e.g. `@elizaos/plugin-sub-agent-claude-code`). The host trusts these
 *   the same way it trusts a direct-mode plugin shipped in node_modules.
 */
export type RemotePluginInstallSource =
	| { kind: "inline"; files: Record<string, string> }
	| {
			kind: "tarball";
			url: string;
			attestation: { signedBy: string; signature: string };
	  }
	| { kind: "workspace"; pkgName: string };

/** Options for {@link IAgentRuntime.installRemotePlugin}. */
export interface RemotePluginInstallOptions {
	source: RemotePluginInstallSource;
	/**
	 * Override the lifetime declared on the manifest. Default:
	 * - `"session"` when source is `"inline"` (agent-generated).
	 * - `"persistent"` when source is `"tarball"` or `"workspace"`.
	 */
	lifetime?: "session" | "persistent";
}

/** Returned by {@link IAgentRuntime.installRemotePlugin}. */
export interface RemotePluginInstanceHandle {
	/** The Plugin.name after install. */
	pluginName: string;
	/**
	 * Per-installation id. Multiple installations of the same plugin (e.g.
	 * two sub-agent sessions) have different instanceIds and live in
	 * different store directories.
	 */
	instanceId: string;
	/**
	 * The granted permissions for this installation, after narrowing. May
	 * be narrower than the requested ceiling in `plugin.remote.permissions`.
	 */
	grantedPermissions: RemotePluginPermissions;
	/** Tear down: stop the worker, unregister the plugin, clean up the store dir if session-lifetime. */
	uninstall(): Promise<void>;
}

/**
 * Thrown by {@link IAgentRuntime.installRemotePlugin} when the plugin's
 * requested permissions narrow to nothing for at least one critical
 * capability (e.g. asks for `fs.readwrite` but the agent only has
 * `fs.readonly`). Caller can catch + prompt the user for elevation.
 */
export class PermissionNarrowedRejection extends Error {
	constructor(
		message: string,
		readonly capability: string,
		readonly requested: unknown,
		readonly granted: unknown,
	) {
		super(message);
		this.name = "PermissionNarrowedRejection";
	}
}

export interface Plugin {
	name: string;
	description: string;

	/**
	 * Execution mode. Default `"direct"` — i.e., the plugin is loaded in-process
	 * and registered with the runtime exactly as plugins have always been.
	 * Setting `"remote"` requires a {@link Plugin.remote} block; the host
	 * installs the plugin via `RemotePluginHost` and the runtime mirrors its
	 * surfaces through proxies across the wire envelope.
	 *
	 * For remote-mode plugins, the surface arrays (`actions`, `providers`,
	 * `services`, `models`, `events`, `routes`, `views`, `widgets`,
	 * `componentTypes`, `evaluators`, `init`) describe what the WORKER
	 * contributes; the host runtime materialises matching proxies.
	 */
	mode?: PluginMode;

	/** Remote-mode configuration. Required when {@link Plugin.mode} is `"remote"`. */
	remote?: RemotePluginConfig;

	/**
	 * Optional pre-initialization hook invoked by the plugin resolver once the
	 * plugin module has loaded, before `init` runs. Use it to prepare a
	 * plugin-owned load-time dependency that must exist before the plugin's
	 * services start — for example linking or building a companion binary the
	 * plugin's own service spawns lazily later.
	 *
	 * The resolver calls this generically for every plugin that declares it, so
	 * package-specific preparation lives with the plugin instead of a name-keyed
	 * branch in the resolver. A missing optional dependency should degrade (log
	 * and return) rather than throw: `preflight` prepares, it does not gate the
	 * load. Reserve throwing for a genuinely fatal precondition.
	 */
	preflight?: () => Promise<void> | void;

	// Initialize plugin with runtime services
	init?: (
		config: Record<string, string>,
		runtime: IAgentRuntime,
	) => Promise<void> | void;

	/**
	 * Optional lifecycle hook invoked before a plugin is unloaded from a running runtime.
	 * Use this to clean up timers, sockets, or other plugin-owned resources.
	 */
	dispose?: (runtime: IAgentRuntime) => Promise<void> | void;

	/**
	 * Optional lifecycle hook invoked for config-only updates that do not require
	 * a full plugin reload.
	 */
	applyConfig?: (
		config: Record<string, string>,
		runtime: IAgentRuntime,
	) => Promise<void> | void;

	/** Plugin configuration - string keys to primitive values */
	config?: Record<string, string | number | boolean | null>;

	/**
	 * Service classes to be registered with the runtime.
	 * Uses ServiceClass interface which is more flexible than `typeof Service`
	 * to allow service classes with specific serviceType values.
	 */
	services?: ServiceClass[];

	/** Entity component definitions with JSON schema */
	componentTypes?: ComponentTypeDefinition[];

	// Optional plugin features
	actions?: Action[];
	providers?: Provider[];
	/**
	 * Pre-LLM action shortcuts (#8791): deterministic slash/`!` commands and
	 * confidence-floored natural-language phrases that resolve to a target before
	 * the first model call. Registered into the runtime's `ShortcutRegistry`.
	 */
	shortcuts?: ShortcutDefinition[];
	/**
	 * Chat pre-handlers: generic pre-action dispatch hooks drained at the top of
	 * the chat loop, before normal action processing. A plugin owning a
	 * deterministic direct-dispatch feature (e.g. a vendor skill family)
	 * registers its trigger + dispatch here instead of the host hardcoding it.
	 * Registered into the runtime's `ChatPreHandlerRegistry`.
	 */
	chatPreHandlers?: ChatPreHandler[];
	evaluators?: RegisteredEvaluator[];
	responseHandlerEvaluators?: ResponseHandlerEvaluator[];
	/**
	 * Field evaluators that contribute schema fragments and handlers to the
	 * Stage-1 response handler's single LLM call. See
	 * `runtime/response-handler-field-evaluator.ts`.
	 */
	responseHandlerFieldEvaluators?: ResponseHandlerFieldEvaluator[];

	/**
	 * Database adapter factory. When set, this plugin provides the database
	 * adapter. Called before runtime construction with agentId and basic-capabilities
	 * settings (character + env, not DB). Only one plugin per character should
	 * set this.
	 */
	adapter?: AdapterFactory;
	models?: {
		[K in keyof ModelParamsMap]?: (
			runtime: IAgentRuntime,
			params: ModelParamsMap[K],
		) => Promise<PluginModelResult<K>>;
	};
	/**
	 * Optional handler-free metadata for entries declared in `models`, keyed by
	 * model type. Providers use this to publish display/routing facts without
	 * core branching on provider names.
	 */
	modelMetadata?: Record<string, ModelRegistrationMetadata>;
	events?: PluginEvents;
	routes?: Route[];
	/**
	 * Connector source names and aliases owned by this plugin. The runtime
	 * registers these during plugin registration so source normalization and
	 * connector-source metadata live with the connector plugin instead of in
	 * core/shared trunk maps.
	 */
	connectorSources?: ConnectorSourceDefinition[];
	tests?: TestSuite[];

	dependencies?: string[];

	testDependencies?: string[];

	priority?: number;

	schema?: Record<string, JsonValue | object>;

	app?: PluginApp;
	appBridge?: PluginAppBridge;

	/**
	 * UI views this plugin contributes. Views are compiled to bundles, served
	 * by the agent at `/api/views/<id>/bundle.js`, and dynamically loaded by
	 * the frontend shell. Replaces the static import pattern in `main.tsx`.
	 *
	 * The view registry scans loaded plugins for this field at startup and on
	 * plugin hot-reload, resolving `bundlePath` entries to absolute serve URLs.
	 */
	views?: ViewDeclaration[];

	/**
	 * Widgets this plugin contributes. Replaces the hard-coded
	 * `PLUGIN_WIDGET_MAP` in `@elizaos/agent` for plugins that adopt this
	 * field. The shell merges plugin-declared widgets with any legacy map
	 * entries at runtime.
	 */
	widgets?: PluginWidgetDeclaration[];

	/**
	 * Domain contexts this plugin's components belong to.
	 * Acts as a default for all actions/providers/evaluators in the plugin
	 * unless they declare their own contexts.
	 */
	contexts?: AgentContext[];

	/**
	 * Declarative auto-enable conditions. When present, the plugin self-describes
	 * when it should be activated — replacing (or supplementing) the hardcoded
	 * maps in `plugin-auto-enable.ts`.
	 *
	 * The runtime evaluates these after initial plugin resolution:
	 * - `envKeys`: enable when ANY of these env vars are set and non-empty.
	 * - `connectorKeys`: enable when ANY of these connector names appear and
	 *   are configured in `config.connectors`.
	 * - `shouldEnable`: custom predicate for complex enable logic.
	 *
	 * All three are OR'd — if any condition is met the plugin is auto-enabled.
	 * The hardcoded map in `plugin-auto-enable.ts` still serves as a fallback
	 * for plugins without `autoEnable`.
	 */
	autoEnable?: {
		/** Enable when any of these env vars are set and non-empty. */
		envKeys?: string[];
		/** Enable when any of these connector names appear in config.connectors. */
		connectorKeys?: string[];
		/** Custom predicate for complex enable logic. */
		shouldEnable?: (
			env: Record<string, string | undefined>,
			config: Record<string, unknown>,
		) => boolean | Promise<boolean>;
	};
}

export interface ProjectAgent {
	character: Character;
	init?: (runtime: IAgentRuntime) => Promise<void>;
	plugins?: Plugin[];
	tests?: TestSuite | TestSuite[];
}

export interface Project {
	agents: ProjectAgent[];
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";

export interface RouteManifest {
	method: HttpMethod;
	path: string;
	name?: string;
	public?: boolean;
	isMultipart?: boolean;
	filePath?: string;
	x402?: X402Config;
}
