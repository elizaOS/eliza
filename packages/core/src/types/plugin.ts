import type { Character } from "./agent";
import type { Action, AgentContext, Provider } from "./components";
import type { IDatabaseAdapter } from "./database";
import type { Evaluator } from "./evaluator";
import type { EventHandler, EventPayload, EventPayloadMap } from "./events";
import type { ModelParamsMap, PluginModelResult } from "./model";
import type { X402Config, X402RequestValidator } from "./payment";
import type { JsonValue, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { Service } from "./service";
import type { TestSuite } from "./testing";

/**
 * Type for a service class constructor.
 * This is more flexible than `typeof Service` to allow for:
 * - Service classes with more specific `serviceType` values (e.g., "task" instead of string)
 * - Service classes that properly extend the base Service class
 */
export interface ServiceClass {
	/** The service type identifier */
	serviceType: string;
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

interface BaseRoute {
	type: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
	path: string;
	filePath?: string;
	handler?: (
		req: RouteRequest,
		res: RouteResponse,
		runtime: IAgentRuntime,
	) => Promise<void>;
	isMultipart?: boolean; // Indicates if the route expects multipart/form-data (file uploads)
	/**
	 * When true, the route path is used as-is without the plugin-name prefix.
	 * Use for legacy API paths that must remain stable (e.g. `/api/telegram-setup/status`).
	 */
	rawPath?: boolean;
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
}

interface PrivateRoute extends BaseRoute {
	public?: false;
	name?: string; // Name is optional for private routes
}

export type Route = PublicRoute | PrivateRoute;

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
	handleAppRoutes?: (ctx: unknown) => Promise<boolean>;
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
	/** Sort priority within the nav (lower = first). Default 100. */
	order?: number;
	/**
	 * If true, this tab is only visible when Developer Mode is enabled
	 * in Settings. Defaults to false.
	 */
	developerOnly?: boolean;
	/**
	 * Optional named group the tab belongs to (used by the shell to render
	 * grouped tab strips, e.g. workbench/dev/wallet groupings).
	 */
	group?: string;
	/**
	 * Optional package export specifier the shell will dynamically import
	 * when the tab is activated, e.g. "@elizaos/app-wallet/ui#InventoryView".
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
export interface PluginWidgetDeclaration {
	/** Unique within the owning plugin, e.g. "lifeops-overview". */
	id: string;
	/** Owning plugin ID. */
	pluginId: string;
	/** Where this widget renders. */
	slot:
		| "chat-sidebar"
		| "chat-inline"
		| "wallet"
		| "browser"
		| "heartbeats"
		| "character"
		| "settings"
		| "nav-page"
		| "automations";
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
	 * in Settings. Defaults to false.
	 */
	developerOnly?: boolean;
	/**
	 * Optional package export specifier the shell will dynamically import
	 * when rendering. Format: "<package-subpath>#<named-export>".
	 */
	componentExport?: string;
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
	/**
	 * If true, the app is a developer-tooling surface (logs, trajectory
	 * viewer, etc.) and is hidden from the main UI unless Developer Mode is
	 * enabled in Settings. Defaults to false.
	 */
	developerOnly?: boolean;
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
	evaluators: Evaluator[];
	routes: Route[];
	events: PluginEventRegistration[];
	models: PluginModelRegistration[];
	services: PluginServiceRegistration[];
	sendHandlerSources: string[];
	hasAdapter: boolean;
	registeredAt: number;
}

export interface Plugin {
	name: string;
	description: string;

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
	evaluators?: Evaluator[];

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
	events?: PluginEvents;
	routes?: Route[];
	tests?: TestSuite[];

	dependencies?: string[];

	testDependencies?: string[];

	priority?: number;

	schema?: Record<string, JsonValue | object>;

	app?: PluginApp;
	appBridge?: PluginAppBridge;

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
	 * for plugins that have not yet adopted `autoEnable`.
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
		) => boolean;
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
