/** Capability contracts; imported directly by internal consumers. */

import type { JsonObject, JsonValue } from "../types/primitives";
import type {
	PageLayoutManifest,
	SurfaceCapability,
} from "../types/surface-manifest";
import type { WorkspaceDeltaReceipt } from "../types/workspace-delta";

export const CAPABILITY_ROUTER_SERVICE_TYPE = "capability-router" as const;

export type CapabilityEnvironment =
	| "desktop"
	| "node"
	| "server"
	| "browser"
	| "mobile"
	| "unknown";

export type CapabilityName = "fs" | "pty" | "git" | "model" | "plugin";

export type CapabilityAvailability = {
	environment: CapabilityEnvironment;
	available: boolean;
	capabilities: Record<CapabilityName, boolean>;
	reason?: string;
};

export type CapabilityEndpointSelection = {
	endpointId?: string;
};

export type CapabilityErrorCode =
	| "CAPABILITY_UNAVAILABLE"
	| "CAPABILITY_DECODE_FAILED"
	| "CAPABILITY_REQUEST_FAILED";

export type CapabilityErrorPayload = {
	code: CapabilityErrorCode;
	message: string;
	capability?: CapabilityName;
	method?: string;
	details?: JsonValue;
};

export class CapabilityError extends Error {
	readonly code: CapabilityErrorCode;
	readonly capability?: CapabilityName;
	readonly method?: string;
	readonly details?: JsonValue;

	constructor(payload: CapabilityErrorPayload) {
		super(payload.message);
		this.name = "CapabilityError";
		this.code = payload.code;
		this.capability = payload.capability;
		this.method = payload.method;
		this.details = payload.details;
	}

	toJSON(): CapabilityErrorPayload {
		return {
			code: this.code,
			message: this.message,
			...(this.capability === undefined ? {} : { capability: this.capability }),
			...(this.method === undefined ? {} : { method: this.method }),
			...(this.details === undefined ? {} : { details: this.details }),
		};
	}
}

export type FileReadTextParams = CapabilityEndpointSelection & {
	path: string;
	/** Positive safe-integer acceptance ceiling; over-limit files are rejected. */
	maxBytes?: number;
	traceSessionId?: string;
};

export type FileReadTextResult = {
	path: string;
	text: string;
	size: number;
	/** Compatibility field. Successful reads always return complete text. */
	truncated: false;
};

export type FileEntryKind = "file" | "directory" | "symlink" | "other";

export type FileStat = {
	path: string;
	name: string;
	kind: FileEntryKind;
	size: number;
	modifiedAt?: string;
	isText?: boolean;
};

export type FileListParams = CapabilityEndpointSelection & {
	path?: string;
	rootId?: string;
	limit?: number;
	includeHidden?: boolean;
	ignore?: string[];
	traceSessionId?: string;
};

export type FileListResult = {
	root: JsonObject;
	path: string;
	entries: FileStat[];
	truncated: boolean;
	totalAfterIgnore: number;
};

export type FileWriteTextParams = CapabilityEndpointSelection & {
	path: string;
	text: string;
	createDirectories?: boolean;
	overwrite?: boolean;
	traceSessionId?: string;
};

export type FileWriteTextResult = {
	/** Path the provider wrote, in the provider's own namespace. */
	path: string;
	bytesWritten: number;
	/**
	 * The caller's requested path, echoed by providers that translate paths
	 * (e.g. a host workspace path mapped into a sandbox workdir).
	 */
	requestedPath?: string;
};

export type TerminalRunParams = CapabilityEndpointSelection & {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
	traceSessionId?: string;
};

export type TerminalRunResult = {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	workspaceExecution?: {
		root: string;
		rootId: string;
		executionDomainId: string;
	};
	workspaceDeltaReceipt?: WorkspaceDeltaReceipt;
};

export type GitStatusParams = CapabilityEndpointSelection & {
	root: string;
	traceSessionId?: string;
};

export type GitStatusResult = {
	repo: JsonObject;
	branch?: string;
	ahead?: number;
	behind?: number;
	files: JsonObject[];
	raw: string;
};

export type GitDiffParams = CapabilityEndpointSelection & {
	root: string;
	path?: string;
	staged?: boolean;
	traceSessionId?: string;
};

export type GitDiffResult = {
	raw: string;
};

export type GitCommandRunParams = CapabilityEndpointSelection & {
	root: string;
	args: string[];
	traceSessionId?: string;
};

export type GitOperationStatus = "running" | "completed" | "failed";

export type GitOperation = {
	id: string;
	name: string;
	cwd: string;
	command: string[];
	status: GitOperationStatus;
	stdout: string;
	stderr: string;
	exitCode?: number | null;
	signal?: string | null;
	startedAt: string;
	completedAt?: string;
	error?: string;
};

export type GitCommandRunResult = {
	operation: GitOperation;
};

export type LocalModelStatusResult = {
	ok: boolean;
	provider?: string;
	raw?: JsonValue;
};

export type LocalModelStatusParams = CapabilityEndpointSelection & {
	traceSessionId?: string;
};

export type RemotePluginActionManifest = {
	name: string;
	description: string;
	descriptionCompressed?: string;
	similes?: string[];
	parameters?: JsonValue;
};

export type RemotePluginProviderManifest = {
	name: string;
	description?: string;
	descriptionCompressed?: string;
	dynamic?: boolean;
	private?: boolean;
};

export type RemotePluginRouteManifest = {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "STATIC";
	path: string;
	name?: string;
	public?: boolean;
	publicReason?: string;
	publicWrite?: string;
	description?: string;
};

export type RemotePluginBackgroundPolicy = "opaque" | "shared";

export type RemotePluginSurfaceManifest = JsonObject & {
	background?: RemotePluginBackgroundPolicy;
	header?: "normal" | "fullscreen" | "modal" | "immersive";
	isolation?:
		| "in-process"
		| "sandboxed-iframe"
		| "native-webview"
		| "immersive";
	lifecycle?: "ephemeral" | "retained";
	capabilities?: SurfaceCapability[];
	layout?: PageLayoutManifest;
};

export type RemotePluginViewManifest = {
	viewKind?: import("../views/declarations.js").ViewKind;
	id: string;
	label: string;
	viewType?: "gui" | "tui" | "xr";

	surface?: RemotePluginSurfaceManifest;
	bundlePath?: string;
	bundleUrl?: string;
	framePath?: string;
	frameUrl?: string;
	contentType?: string;
	integrity?: string;
};

export type RemotePluginEvaluatorManifest = {
	name: string;
	description: string;
	prompt: string;
	similes?: string[];
	priority?: number;
	providers?: string[];
	schema: JsonObject;
	modelType?: string;
	hasPrepare?: boolean;
	hasProcessor?: boolean;
};

export type RemotePluginResponseHandlerEvaluatorManifest = {
	name: string;
	description?: string;
	priority?: number;
};

export type RemotePluginResponseHandlerFieldEvaluatorManifest = {
	name: string;
	description: string;
	priority?: number;
	schema: JsonObject;
	hasParse?: boolean;
	hasHandle?: boolean;
};

export type RemotePluginEventManifest = {
	eventName: string;
};

export type RemotePluginModelManifest = {
	modelType: string;
	priority?: number;
};

export type RemotePluginServiceManifest = {
	serviceType: string;
	capabilityDescription?: string;
	methods?: string[];
	config?: JsonObject;
};

export type RemotePluginJsonSchemaDefinition = {
	type: string;
	properties?: Record<string, RemotePluginJsonSchemaDefinition>;
	items?: RemotePluginJsonSchemaDefinition;
	required?: string[];
	enumValues?: string[];
	description?: string;
};

export type RemotePluginComponentTypeManifest = {
	name: string;
	schema: RemotePluginJsonSchemaDefinition;
};

export type RemotePluginWidgetManifest = {
	id: string;
	pluginId?: string;
	slot: "chat-sidebar" | "character" | "nav-page";
	label: string;
	icon?: string;
	order?: number;
	defaultEnabled?: boolean;
	navGroup?: string;
	viewKind?: import("../views/declarations.js").ViewKind;
	componentExport?: string;
};

export type RemotePluginAppViewerManifest = {
	url: string;
	embedParams?: Record<string, string>;
	postMessageAuth?: boolean;
	sandbox?: string;
};

export type RemotePluginAppSessionManifest = {
	mode: "viewer" | "spectate-and-steer" | "external";
	features?: Array<
		"commands" | "telemetry" | "pause" | "resume" | "suggestions"
	>;
};

export type RemotePluginAppNavTabManifest = {
	id: string;
	label: string;
	icon?: string;
	path: string;
	order?: number;
	viewKind?: import("../views/declarations.js").ViewKind;
	group?: string;

	surface?: RemotePluginSurfaceManifest;
	componentExport?: string;
};

export type RemotePluginAppManifest = {
	displayName?: string;
	category?: string;
	launchType?: string;
	launchUrl?: string | null;
	icon?: string | null;
	capabilities?: string[];
	minPlayers?: number | null;
	maxPlayers?: number | null;
	runtimePlugin?: string;
	viewer?: RemotePluginAppViewerManifest;
	session?: RemotePluginAppSessionManifest;
	bridgeExport?: string;
	uiExtension?: {
		detailPanelId?: string;
	};
	viewKind?: import("../views/declarations.js").ViewKind;
	visibleInAppStore?: boolean;
	navTabs?: RemotePluginAppNavTabManifest[];
};

export type RemotePluginAppBridgeHook =
	| "prepareLaunch"
	| "resolveViewerAuthMessage"
	| "ensureRuntimeReady"
	| "collectLaunchDiagnostics"
	| "resolveLaunchSession"
	| "refreshRunSession"
	| "stopRun"
	| "handleAppRoutes";

export type RemotePluginAppBridgeManifest = {
	hooks: RemotePluginAppBridgeHook[];
};

export type RemotePluginLifecycleHook = "init" | "dispose" | "applyConfig";

export type RemotePluginLifecycleManifest = {
	hooks: RemotePluginLifecycleHook[];
};

export type RemotePluginConfigValue = string | number | boolean | null;

export type RemotePluginConfigMap = Record<string, RemotePluginConfigValue>;

export type RemotePluginModuleProvenance = {
	issuer: string;
	subject: string;
	digestSha256: string;
	signatureAlgorithm: string;
	signature: string;
};

export type RemotePluginModuleManifest = {
	id: string;
	name: string;
	/** Assigned by an aggregating capability router so RPC calls stay bound to the endpoint that supplied this module. */
	capabilityEndpointId?: string;
	version?: string;
	description?: string;
	priority?: number;
	contexts?: string[];
	config?: RemotePluginConfigMap;
	schema?: JsonObject;
	actions?: RemotePluginActionManifest[];
	providers?: RemotePluginProviderManifest[];
	evaluators?: RemotePluginEvaluatorManifest[];
	responseHandlerEvaluators?: RemotePluginResponseHandlerEvaluatorManifest[];
	responseHandlerFieldEvaluators?: RemotePluginResponseHandlerFieldEvaluatorManifest[];
	events?: RemotePluginEventManifest[];
	models?: RemotePluginModelManifest[];
	services?: RemotePluginServiceManifest[];
	componentTypes?: RemotePluginComponentTypeManifest[];
	widgets?: RemotePluginWidgetManifest[];
	app?: RemotePluginAppManifest;
	appBridge?: RemotePluginAppBridgeManifest;
	lifecycle?: RemotePluginLifecycleManifest;
	routes?: RemotePluginRouteManifest[];
	views?: RemotePluginViewManifest[];
	provenance?: RemotePluginModuleProvenance;
	metadata?: JsonObject;
};

export type PluginListModulesParams = CapabilityEndpointSelection & {
	traceSessionId?: string;
};

export type PluginListModulesResult = {
	modules: RemotePluginModuleManifest[];
};

export type PluginInvokeActionParams = CapabilityEndpointSelection & {
	moduleId: string;
	action: string;
	content?: JsonObject;
	options?: JsonObject;
	traceSessionId?: string;
};

export type PluginInvokeActionResult = {
	text?: string;
	actions?: string[];
	values?: JsonObject;
	data?: JsonObject;
};

export type PluginGetProviderParams = CapabilityEndpointSelection & {
	moduleId: string;
	provider: string;
	state?: JsonObject;
	traceSessionId?: string;
};

export type PluginGetProviderResult = {
	text?: string;
	values?: JsonObject;
	data?: JsonObject;
};

export type PluginCallRouteParams = CapabilityEndpointSelection & {
	moduleId: string;
	method: string;
	path: string;
	body?: JsonValue;
	query?: Record<string, string | string[]>;
	headers?: Record<string, string>;
	traceSessionId?: string;
};

export type PluginCallRouteResult = {
	status: number;
	headers?: Record<string, string>;
	body?: JsonValue;
};

export type PluginGetAssetParams = CapabilityEndpointSelection & {
	moduleId: string;
	path: string;
	traceSessionId?: string;
};

export type PluginGetAssetResult = {
	path: string;
	contentType: string;
	bodyBase64: string;
	integrity?: string;
};

export type PluginEvaluatorShouldRunParams = CapabilityEndpointSelection & {
	moduleId: string;
	evaluator: string;
	message?: JsonObject;
	state?: JsonObject;
	options?: JsonObject;
	traceSessionId?: string;
};

export type PluginEvaluatorShouldRunResult = {
	shouldRun: boolean;
};

export type PluginEvaluatorPrepareParams = PluginEvaluatorShouldRunParams;

export type PluginEvaluatorPrepareResult = {
	prepared?: JsonValue;
};

export type PluginEvaluatorPromptParams = PluginEvaluatorShouldRunParams & {
	prepared?: JsonValue;
};

export type PluginEvaluatorPromptResult = {
	prompt: string;
};

export type PluginEvaluatorProcessParams = PluginEvaluatorPromptParams & {
	output?: JsonValue;
};

export type PluginEvaluatorProcessResult = {
	result?: JsonObject;
};

export type PluginResponseHandlerEvaluatorShouldRunParams =
	CapabilityEndpointSelection & {
		moduleId: string;
		evaluator: string;
		context?: JsonObject;
		traceSessionId?: string;
	};

export type PluginResponseHandlerEvaluatorShouldRunResult = {
	shouldRun: boolean;
};

export type PluginResponseHandlerEvaluatorEvaluateParams =
	PluginResponseHandlerEvaluatorShouldRunParams;

export type PluginResponseHandlerEvaluatorEvaluateResult = {
	patch?: JsonObject;
};

export type PluginResponseHandlerFieldEvaluatorShouldRunParams =
	CapabilityEndpointSelection & {
		moduleId: string;
		field: string;
		context?: JsonObject;
		traceSessionId?: string;
	};

export type PluginResponseHandlerFieldEvaluatorShouldRunResult = {
	shouldRun: boolean;
};

export type PluginResponseHandlerFieldEvaluatorParseParams =
	PluginResponseHandlerFieldEvaluatorShouldRunParams & {
		value?: JsonValue;
	};

export type PluginResponseHandlerFieldEvaluatorParseResult = {
	value?: JsonValue;
	softFail?: boolean;
};

export type PluginResponseHandlerFieldEvaluatorHandleParams =
	PluginResponseHandlerFieldEvaluatorParseParams & {
		parsed?: JsonObject;
	};

export type PluginResponseHandlerFieldEvaluatorHandleResult = {
	effect?: {
		patch?: JsonObject;
		preempt?: {
			mode: "ack-and-stop" | "ignore" | "direct-reply";
			reason: string;
		};
		debug?: string[];
	};
};

export type PluginLifecycleCallParams = CapabilityEndpointSelection & {
	moduleId: string;
	hook: RemotePluginLifecycleHook;
	config?: Record<string, string>;
	context?: JsonObject;
	traceSessionId?: string;
};

export type PluginLifecycleCallResult = {
	ok: boolean;
};

export type PluginHandleEventParams = CapabilityEndpointSelection & {
	moduleId: string;
	eventName: string;
	payload?: JsonObject;
	traceSessionId?: string;
};

export type PluginHandleEventResult = {
	handled: boolean;
};

export type PluginInvokeModelParams = CapabilityEndpointSelection & {
	moduleId: string;
	modelType: string;
	params?: JsonValue;
	traceSessionId?: string;
};

export type PluginInvokeModelResult = {
	result: JsonValue;
};

export type PluginCallServiceParams = CapabilityEndpointSelection & {
	moduleId: string;
	serviceType: string;
	method: string;
	args?: JsonValue[];
	traceSessionId?: string;
};

export type PluginCallServiceResult = {
	result?: JsonValue;
};

export type PluginCallAppBridgeParams = CapabilityEndpointSelection & {
	moduleId: string;
	hook: RemotePluginAppBridgeHook;
	context?: JsonObject;
	traceSessionId?: string;
};

export type PluginCallAppBridgeResult = {
	result?: JsonValue;
};

export interface FileCapability {
	list(params?: FileListParams): Promise<FileListResult>;
	readText(params: FileReadTextParams): Promise<FileReadTextResult>;
	writeText(params: FileWriteTextParams): Promise<FileWriteTextResult>;
}

export interface TerminalCapability {
	runCommand(params: TerminalRunParams): Promise<TerminalRunResult>;
}

export interface GitCapability {
	status(params: GitStatusParams): Promise<GitStatusResult>;
	diff(params: GitDiffParams): Promise<GitDiffResult>;
	commandRun(params: GitCommandRunParams): Promise<GitCommandRunResult>;
}

export interface LocalModelCapability {
	status(params?: LocalModelStatusParams): Promise<LocalModelStatusResult>;
}

export interface RemotePluginCapability {
	listModules(
		params?: PluginListModulesParams,
	): Promise<PluginListModulesResult>;
	invokeAction(
		params: PluginInvokeActionParams,
	): Promise<PluginInvokeActionResult>;
	getProvider(
		params: PluginGetProviderParams,
	): Promise<PluginGetProviderResult>;
	callRoute(params: PluginCallRouteParams): Promise<PluginCallRouteResult>;
	getAsset(params: PluginGetAssetParams): Promise<PluginGetAssetResult>;
	shouldRunEvaluator(
		params: PluginEvaluatorShouldRunParams,
	): Promise<PluginEvaluatorShouldRunResult>;
	prepareEvaluator(
		params: PluginEvaluatorPrepareParams,
	): Promise<PluginEvaluatorPrepareResult>;
	promptEvaluator(
		params: PluginEvaluatorPromptParams,
	): Promise<PluginEvaluatorPromptResult>;
	processEvaluator(
		params: PluginEvaluatorProcessParams,
	): Promise<PluginEvaluatorProcessResult>;
	shouldRunResponseHandlerEvaluator(
		params: PluginResponseHandlerEvaluatorShouldRunParams,
	): Promise<PluginResponseHandlerEvaluatorShouldRunResult>;
	evaluateResponseHandlerEvaluator(
		params: PluginResponseHandlerEvaluatorEvaluateParams,
	): Promise<PluginResponseHandlerEvaluatorEvaluateResult>;
	shouldRunResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorShouldRunParams,
	): Promise<PluginResponseHandlerFieldEvaluatorShouldRunResult>;
	parseResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorParseParams,
	): Promise<PluginResponseHandlerFieldEvaluatorParseResult>;
	handleResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorHandleParams,
	): Promise<PluginResponseHandlerFieldEvaluatorHandleResult>;
	callLifecycle(
		params: PluginLifecycleCallParams,
	): Promise<PluginLifecycleCallResult>;
	handleEvent(
		params: PluginHandleEventParams,
	): Promise<PluginHandleEventResult>;
	invokeModel(
		params: PluginInvokeModelParams,
	): Promise<PluginInvokeModelResult>;
	callService(
		params: PluginCallServiceParams,
	): Promise<PluginCallServiceResult>;
	callAppBridge(
		params: PluginCallAppBridgeParams,
	): Promise<PluginCallAppBridgeResult>;
}

export interface ElizaCapabilityRouter {
	readonly environment: CapabilityEnvironment;
	availability(): Promise<CapabilityAvailability>;
	readonly fs: FileCapability;
	readonly pty: TerminalCapability;
	readonly git: GitCapability;
	readonly model: LocalModelCapability;
	readonly plugin: RemotePluginCapability;
}

export type RuntimeBrokerCapabilityMethod =
	| "fs.list"
	| "fs.readText"
	| "fs.writeText"
	| "pty.command.run"
	| "git.status"
	| "git.diff"
	| "git.command.run"
	| "model.status"
	| "plugin.modules.list"
	| "plugin.action.invoke"
	| "plugin.provider.get"
	| "plugin.route.call"
	| "plugin.asset.get"
	| "plugin.evaluator.shouldRun"
	| "plugin.evaluator.prepare"
	| "plugin.evaluator.prompt"
	| "plugin.evaluator.process"
	| "plugin.responseHandlerEvaluator.shouldRun"
	| "plugin.responseHandlerEvaluator.evaluate"
	| "plugin.responseHandlerFieldEvaluator.shouldRun"
	| "plugin.responseHandlerFieldEvaluator.parse"
	| "plugin.responseHandlerFieldEvaluator.handle"
	| "plugin.lifecycle.call"
	| "plugin.event.handle"
	| "plugin.model.invoke"
	| "plugin.service.call"
	| "plugin.appBridge.call";

export type RuntimeBrokerInvoke = (
	method: RuntimeBrokerCapabilityMethod,
	params?: JsonObject,
) => Promise<JsonValue | undefined>;

export type RuntimeBrokerCapabilityRouterOptions = {
	environment?: CapabilityEnvironment;
	invokeRuntime: RuntimeBrokerInvoke;
};
