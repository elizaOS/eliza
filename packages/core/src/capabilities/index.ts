import type { JsonObject, JsonValue } from "../types/primitives";

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
	maxBytes?: number;
	traceSessionId?: string;
};

export type FileReadTextResult = {
	path: string;
	text: string;
	size: number;
	truncated: boolean;
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
	path: string;
	bytesWritten: number;
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
	description?: string;
};

export type RemotePluginViewManifest = {
	id: string;
	label: string;
	viewType?: "gui" | "tui";
	bundlePath?: string;
	bundleUrl?: string;
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

export type RemotePluginWidgetManifest = {
	id: string;
	pluginId?: string;
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
	label: string;
	icon?: string;
	order?: number;
	defaultEnabled?: boolean;
	navGroup?: string;
	developerOnly?: boolean;
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
	developerOnly?: boolean;
	group?: string;
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
	developerOnly?: boolean;
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
export type RemotePluginConfig = Record<string, RemotePluginConfigValue>;

export type RemotePluginModuleManifest = {
	id: string;
	name: string;
	/** Assigned by an aggregating capability router so RPC calls stay bound to the endpoint that supplied this module. */
	capabilityEndpointId?: string;
	version?: string;
	description?: string;
	config?: RemotePluginConfig;
	schema?: JsonObject;
	actions?: RemotePluginActionManifest[];
	providers?: RemotePluginProviderManifest[];
	evaluators?: RemotePluginEvaluatorManifest[];
	responseHandlerEvaluators?: RemotePluginResponseHandlerEvaluatorManifest[];
	responseHandlerFieldEvaluators?: RemotePluginResponseHandlerFieldEvaluatorManifest[];
	events?: RemotePluginEventManifest[];
	models?: RemotePluginModelManifest[];
	services?: RemotePluginServiceManifest[];
	widgets?: RemotePluginWidgetManifest[];
	app?: RemotePluginAppManifest;
	appBridge?: RemotePluginAppBridgeManifest;
	lifecycle?: RemotePluginLifecycleManifest;
	routes?: RemotePluginRouteManifest[];
	views?: RemotePluginViewManifest[];
	metadata?: JsonObject;
};

export type PluginListModulesParams = {
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

export class UnavailableCapabilityRouter implements ElizaCapabilityRouter {
	readonly fs: FileCapability;
	readonly pty: TerminalCapability;
	readonly git: GitCapability;
	readonly model: LocalModelCapability;
	readonly plugin: RemotePluginCapability;

	constructor(
		readonly environment: CapabilityEnvironment = "unknown",
		private readonly reason = "Capability router is not available.",
	) {
		this.fs = {
			list: (params) =>
				this.unavailable("fs", "fs.list", paramsToDetails(params)),
			readText: (params) =>
				this.unavailable("fs", "fs.readText", { path: params.path }),
			writeText: (params) =>
				this.unavailable("fs", "fs.writeText", { path: params.path }),
		};
		this.pty = {
			runCommand: (params) =>
				this.unavailable("pty", "pty.command.run", {
					command: params.command,
				}),
		};
		this.git = {
			status: (params) =>
				this.unavailable("git", "git.status", { root: params.root }),
			diff: (params) =>
				this.unavailable("git", "git.diff", { root: params.root }),
			commandRun: (params) =>
				this.unavailable("git", "git.command.run", {
					root: params.root,
					args: params.args,
				}),
		};
		this.model = {
			status: () => this.unavailable("model", "model.status"),
		};
		this.plugin = {
			listModules: (params) =>
				this.unavailable(
					"plugin",
					"plugin.modules.list",
					paramsToDetails(params),
				),
			invokeAction: (params) =>
				this.unavailable("plugin", "plugin.action.invoke", {
					moduleId: params.moduleId,
					action: params.action,
				}),
			getProvider: (params) =>
				this.unavailable("plugin", "plugin.provider.get", {
					moduleId: params.moduleId,
					provider: params.provider,
				}),
			callRoute: (params) =>
				this.unavailable("plugin", "plugin.route.call", {
					moduleId: params.moduleId,
					method: params.method,
					path: params.path,
				}),
			getAsset: (params) =>
				this.unavailable("plugin", "plugin.asset.get", {
					moduleId: params.moduleId,
					path: params.path,
				}),
			shouldRunEvaluator: (params) =>
				this.unavailable("plugin", "plugin.evaluator.shouldRun", {
					moduleId: params.moduleId,
					evaluator: params.evaluator,
				}),
			prepareEvaluator: (params) =>
				this.unavailable("plugin", "plugin.evaluator.prepare", {
					moduleId: params.moduleId,
					evaluator: params.evaluator,
				}),
			promptEvaluator: (params) =>
				this.unavailable("plugin", "plugin.evaluator.prompt", {
					moduleId: params.moduleId,
					evaluator: params.evaluator,
				}),
			processEvaluator: (params) =>
				this.unavailable("plugin", "plugin.evaluator.process", {
					moduleId: params.moduleId,
					evaluator: params.evaluator,
				}),
			shouldRunResponseHandlerEvaluator: (params) =>
				this.unavailable(
					"plugin",
					"plugin.responseHandlerEvaluator.shouldRun",
					{
						moduleId: params.moduleId,
						evaluator: params.evaluator,
					},
				),
			evaluateResponseHandlerEvaluator: (params) =>
				this.unavailable("plugin", "plugin.responseHandlerEvaluator.evaluate", {
					moduleId: params.moduleId,
					evaluator: params.evaluator,
				}),
			shouldRunResponseHandlerFieldEvaluator: (params) =>
				this.unavailable(
					"plugin",
					"plugin.responseHandlerFieldEvaluator.shouldRun",
					{
						moduleId: params.moduleId,
						field: params.field,
					},
				),
			parseResponseHandlerFieldEvaluator: (params) =>
				this.unavailable(
					"plugin",
					"plugin.responseHandlerFieldEvaluator.parse",
					{
						moduleId: params.moduleId,
						field: params.field,
					},
				),
			handleResponseHandlerFieldEvaluator: (params) =>
				this.unavailable(
					"plugin",
					"plugin.responseHandlerFieldEvaluator.handle",
					{
						moduleId: params.moduleId,
						field: params.field,
					},
				),
			callLifecycle: (params) =>
				this.unavailable("plugin", "plugin.lifecycle.call", {
					moduleId: params.moduleId,
					hook: params.hook,
				}),
			handleEvent: (params) =>
				this.unavailable("plugin", "plugin.event.handle", {
					moduleId: params.moduleId,
					eventName: params.eventName,
				}),
			invokeModel: (params) =>
				this.unavailable("plugin", "plugin.model.invoke", {
					moduleId: params.moduleId,
					modelType: params.modelType,
				}),
			callService: (params) =>
				this.unavailable("plugin", "plugin.service.call", {
					moduleId: params.moduleId,
					serviceType: params.serviceType,
					method: params.method,
				}),
			callAppBridge: (params) =>
				this.unavailable("plugin", "plugin.appBridge.call", {
					moduleId: params.moduleId,
					hook: params.hook,
				}),
		};
	}

	async availability(): Promise<CapabilityAvailability> {
		return {
			environment: this.environment,
			available: false,
			capabilities: {
				fs: false,
				pty: false,
				git: false,
				model: false,
				plugin: false,
			},
			reason: this.reason,
		};
	}

	private unavailable<T>(
		capability: CapabilityName,
		method: string,
		details?: JsonObject,
	): Promise<T> {
		return Promise.reject(
			new CapabilityError({
				code: "CAPABILITY_UNAVAILABLE",
				message: this.reason,
				capability,
				method,
				...(details === undefined ? {} : { details }),
			}),
		);
	}
}

export class RuntimeBrokerCapabilityRouter implements ElizaCapabilityRouter {
	readonly environment: CapabilityEnvironment;
	readonly fs: FileCapability;
	readonly pty: TerminalCapability;
	readonly git: GitCapability;
	readonly model: LocalModelCapability;
	readonly plugin: RemotePluginCapability;
	private readonly invokeRuntime: RuntimeBrokerInvoke;

	constructor(options: RuntimeBrokerCapabilityRouterOptions) {
		this.environment = options.environment ?? "desktop";
		this.invokeRuntime = options.invokeRuntime;
		this.fs = {
			list: (params) => this.list(params),
			readText: (params) => this.readText(params),
			writeText: (params) => this.writeText(params),
		};
		this.pty = {
			runCommand: (params) => this.runCommand(params),
		};
		this.git = {
			status: (params) => this.gitStatus(params),
			diff: (params) => this.gitDiff(params),
			commandRun: (params) => this.gitCommandRun(params),
		};
		this.model = {
			status: (params) => this.modelStatus(params),
		};
		this.plugin = {
			listModules: (params) => this.listPluginModules(params),
			invokeAction: (params) => this.invokePluginAction(params),
			getProvider: (params) => this.getPluginProvider(params),
			callRoute: (params) => this.callPluginRoute(params),
			getAsset: (params) => this.getPluginAsset(params),
			shouldRunEvaluator: (params) => this.shouldRunPluginEvaluator(params),
			prepareEvaluator: (params) => this.preparePluginEvaluator(params),
			promptEvaluator: (params) => this.promptPluginEvaluator(params),
			processEvaluator: (params) => this.processPluginEvaluator(params),
			shouldRunResponseHandlerEvaluator: (params) =>
				this.shouldRunResponseHandlerEvaluator(params),
			evaluateResponseHandlerEvaluator: (params) =>
				this.evaluateResponseHandlerEvaluator(params),
			shouldRunResponseHandlerFieldEvaluator: (params) =>
				this.shouldRunResponseHandlerFieldEvaluator(params),
			parseResponseHandlerFieldEvaluator: (params) =>
				this.parseResponseHandlerFieldEvaluator(params),
			handleResponseHandlerFieldEvaluator: (params) =>
				this.handleResponseHandlerFieldEvaluator(params),
			callLifecycle: (params) => this.callPluginLifecycle(params),
			handleEvent: (params) => this.handlePluginEvent(params),
			invokeModel: (params) => this.invokePluginModel(params),
			callService: (params) => this.callPluginService(params),
			callAppBridge: (params) => this.callPluginAppBridge(params),
		};
	}

	async availability(): Promise<CapabilityAvailability> {
		return {
			environment: this.environment,
			available: true,
			capabilities: {
				fs: true,
				pty: true,
				git: true,
				model: true,
				plugin: true,
			},
		};
	}

	private async list(params: FileListParams = {}): Promise<FileListResult> {
		const result = await this.request("fs", "fs.list", {
			...(params.path === undefined ? {} : { path: params.path }),
			...(params.rootId === undefined ? {} : { rootId: params.rootId }),
			...(params.limit === undefined ? {} : { limit: params.limit }),
			...(params.includeHidden === undefined
				? {}
				: { includeHidden: params.includeHidden }),
			...(params.ignore === undefined ? {} : { ignore: params.ignore }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "fs.list");
		return {
			root: requireObject(object.root, "fs.list.root"),
			path: requireString(object, "path", "fs.list"),
			entries: requireFileStatArray(object, "entries", "fs.list"),
			truncated: requireBoolean(object, "truncated", "fs.list"),
			totalAfterIgnore: requireNumber(object, "totalAfterIgnore", "fs.list"),
		};
	}

	private async readText(
		params: FileReadTextParams,
	): Promise<FileReadTextResult> {
		const result = await this.request("fs", "fs.readText", {
			path: params.path,
			...(params.maxBytes === undefined ? {} : { maxBytes: params.maxBytes }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "fs.readText");
		return {
			path: requireString(object, "path", "fs.readText"),
			text: requireString(object, "text", "fs.readText"),
			size: requireNumber(object, "size", "fs.readText"),
			truncated: requireBoolean(object, "truncated", "fs.readText"),
		};
	}

	private async writeText(
		params: FileWriteTextParams,
	): Promise<FileWriteTextResult> {
		const result = await this.request("fs", "fs.writeText", {
			path: params.path,
			text: params.text,
			...(params.createDirectories === undefined
				? {}
				: { createDirectories: params.createDirectories }),
			...(params.overwrite === undefined
				? {}
				: { overwrite: params.overwrite }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "fs.writeText");
		return {
			path: requireString(object, "path", "fs.writeText"),
			bytesWritten: requireNumber(object, "bytesWritten", "fs.writeText"),
		};
	}

	private async runCommand(
		params: TerminalRunParams,
	): Promise<TerminalRunResult> {
		const result = await this.request("pty", "pty.command.run", {
			command: params.command,
			...(params.args === undefined ? {} : { args: params.args }),
			...(params.cwd === undefined ? {} : { cwd: params.cwd }),
			...(params.env === undefined ? {} : { env: params.env }),
			...(params.timeoutMs === undefined
				? {}
				: { timeoutMs: params.timeoutMs }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "pty.command.run");
		return {
			output: requireString(object, "output", "pty.command.run"),
			exitCode: nullableNumber(object, "exitCode", "pty.command.run"),
			timedOut: requireBoolean(object, "timedOut", "pty.command.run"),
		};
	}

	private async gitStatus(params: GitStatusParams): Promise<GitStatusResult> {
		const result = await this.request("git", "git.status", {
			cwd: params.root,
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "git.status");
		const branch = optionalString(object, "branch", "git.status");
		const ahead = optionalNumber(object, "ahead", "git.status");
		const behind = optionalNumber(object, "behind", "git.status");
		return {
			repo: requireObject(object.repo, "git.status.repo"),
			...(branch === undefined ? {} : { branch }),
			...(ahead === undefined ? {} : { ahead }),
			...(behind === undefined ? {} : { behind }),
			files: requireObjectArray(object, "files", "git.status"),
			raw: requireString(object, "raw", "git.status"),
		};
	}

	private async gitDiff(params: GitDiffParams): Promise<GitDiffResult> {
		const result = await this.request("git", "git.diff", {
			cwd: params.root,
			...(params.path === undefined ? {} : { path: params.path }),
			...(params.staged === undefined ? {} : { staged: params.staged }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "git.diff");
		return {
			raw: requireString(object, "raw", "git.diff"),
		};
	}

	private async gitCommandRun(
		params: GitCommandRunParams,
	): Promise<GitCommandRunResult> {
		const result = await this.request("git", "git.command.run", {
			cwd: params.root,
			args: params.args,
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "git.command.run");
		return {
			operation: requireGitOperation(
				object.operation,
				"git.command.run.operation",
			),
		};
	}

	private async modelStatus(
		params: LocalModelStatusParams = {},
	): Promise<LocalModelStatusResult> {
		const result = await this.request("model", "model.status", {
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
		});
		const object = requireObject(result, "model.status");
		const provider = optionalString(object, "provider", "model.status");
		return {
			ok: requireBoolean(object, "ok", "model.status"),
			...(provider === undefined ? {} : { provider }),
			raw: object,
		};
	}

	private async listPluginModules(
		params: PluginListModulesParams = {},
	): Promise<PluginListModulesResult> {
		const result = await this.request("plugin", "plugin.modules.list", {
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.modules.list");
		return {
			modules: requireRemotePluginModuleArray(
				object,
				"modules",
				"plugin.modules.list",
			),
		};
	}

	private async invokePluginAction(
		params: PluginInvokeActionParams,
	): Promise<PluginInvokeActionResult> {
		const result = await this.request("plugin", "plugin.action.invoke", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			action: params.action,
			...(params.content === undefined ? {} : { content: params.content }),
			...(params.options === undefined ? {} : { options: params.options }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		return requirePluginActionResult(result, "plugin.action.invoke");
	}

	private async getPluginProvider(
		params: PluginGetProviderParams,
	): Promise<PluginGetProviderResult> {
		const result = await this.request("plugin", "plugin.provider.get", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			provider: params.provider,
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		return requirePluginProviderResult(result, "plugin.provider.get");
	}

	private async callPluginRoute(
		params: PluginCallRouteParams,
	): Promise<PluginCallRouteResult> {
		const result = await this.request("plugin", "plugin.route.call", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			method: params.method,
			path: params.path,
			...(params.body === undefined ? {} : { body: params.body }),
			...(params.query === undefined ? {} : { query: params.query }),
			...(params.headers === undefined ? {} : { headers: params.headers }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.route.call");
		const headers = optionalStringRecord(
			object,
			"headers",
			"plugin.route.call",
		);
		return {
			status: requireNumber(object, "status", "plugin.route.call"),
			...(headers === undefined ? {} : { headers }),
			...(object.body === undefined ? {} : { body: object.body }),
		};
	}

	private async getPluginAsset(
		params: PluginGetAssetParams,
	): Promise<PluginGetAssetResult> {
		const result = await this.request("plugin", "plugin.asset.get", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			path: params.path,
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.asset.get");
		const integrity = optionalString(object, "integrity", "plugin.asset.get");
		return {
			path: requireString(object, "path", "plugin.asset.get"),
			contentType: requireString(object, "contentType", "plugin.asset.get"),
			bodyBase64: requireString(object, "bodyBase64", "plugin.asset.get"),
			...(integrity === undefined ? {} : { integrity }),
		};
	}

	private async shouldRunPluginEvaluator(
		params: PluginEvaluatorShouldRunParams,
	): Promise<PluginEvaluatorShouldRunResult> {
		const result = await this.request("plugin", "plugin.evaluator.shouldRun", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			evaluator: params.evaluator,
			...(params.message === undefined ? {} : { message: params.message }),
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.options === undefined ? {} : { options: params.options }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.evaluator.shouldRun");
		return {
			shouldRun: requireBoolean(
				object,
				"shouldRun",
				"plugin.evaluator.shouldRun",
			),
		};
	}

	private async preparePluginEvaluator(
		params: PluginEvaluatorPrepareParams,
	): Promise<PluginEvaluatorPrepareResult> {
		const result = await this.request("plugin", "plugin.evaluator.prepare", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			evaluator: params.evaluator,
			...(params.message === undefined ? {} : { message: params.message }),
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.options === undefined ? {} : { options: params.options }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.evaluator.prepare");
		return object.prepared === undefined ? {} : { prepared: object.prepared };
	}

	private async promptPluginEvaluator(
		params: PluginEvaluatorPromptParams,
	): Promise<PluginEvaluatorPromptResult> {
		const result = await this.request("plugin", "plugin.evaluator.prompt", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			evaluator: params.evaluator,
			...(params.message === undefined ? {} : { message: params.message }),
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.options === undefined ? {} : { options: params.options }),
			...(params.prepared === undefined ? {} : { prepared: params.prepared }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.evaluator.prompt");
		return {
			prompt: requireString(object, "prompt", "plugin.evaluator.prompt"),
		};
	}

	private async processPluginEvaluator(
		params: PluginEvaluatorProcessParams,
	): Promise<PluginEvaluatorProcessResult> {
		const result = await this.request("plugin", "plugin.evaluator.process", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			evaluator: params.evaluator,
			...(params.message === undefined ? {} : { message: params.message }),
			...(params.state === undefined ? {} : { state: params.state }),
			...(params.options === undefined ? {} : { options: params.options }),
			...(params.prepared === undefined ? {} : { prepared: params.prepared }),
			...(params.output === undefined ? {} : { output: params.output }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.evaluator.process");
		const processorResult = optionalJsonObject(
			object,
			"result",
			"plugin.evaluator.process",
		);
		return processorResult === undefined ? {} : { result: processorResult };
	}

	private async shouldRunResponseHandlerEvaluator(
		params: PluginResponseHandlerEvaluatorShouldRunParams,
	): Promise<PluginResponseHandlerEvaluatorShouldRunResult> {
		const result = await this.request(
			"plugin",
			"plugin.responseHandlerEvaluator.shouldRun",
			{
				...endpointSelection(params),
				moduleId: params.moduleId,
				evaluator: params.evaluator,
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.traceSessionId === undefined
					? {}
					: { traceSessionId: params.traceSessionId }),
			},
		);
		const object = requireObject(
			result,
			"plugin.responseHandlerEvaluator.shouldRun",
		);
		return {
			shouldRun: requireBoolean(
				object,
				"shouldRun",
				"plugin.responseHandlerEvaluator.shouldRun",
			),
		};
	}

	private async evaluateResponseHandlerEvaluator(
		params: PluginResponseHandlerEvaluatorEvaluateParams,
	): Promise<PluginResponseHandlerEvaluatorEvaluateResult> {
		const result = await this.request(
			"plugin",
			"plugin.responseHandlerEvaluator.evaluate",
			{
				...endpointSelection(params),
				moduleId: params.moduleId,
				evaluator: params.evaluator,
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.traceSessionId === undefined
					? {}
					: { traceSessionId: params.traceSessionId }),
			},
		);
		const object = requireObject(
			result,
			"plugin.responseHandlerEvaluator.evaluate",
		);
		const patch = optionalJsonObject(
			object,
			"patch",
			"plugin.responseHandlerEvaluator.evaluate",
		);
		return patch === undefined ? {} : { patch };
	}

	private async shouldRunResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorShouldRunParams,
	): Promise<PluginResponseHandlerFieldEvaluatorShouldRunResult> {
		const result = await this.request(
			"plugin",
			"plugin.responseHandlerFieldEvaluator.shouldRun",
			{
				...endpointSelection(params),
				moduleId: params.moduleId,
				field: params.field,
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.traceSessionId === undefined
					? {}
					: { traceSessionId: params.traceSessionId }),
			},
		);
		const object = requireObject(
			result,
			"plugin.responseHandlerFieldEvaluator.shouldRun",
		);
		return {
			shouldRun: requireBoolean(
				object,
				"shouldRun",
				"plugin.responseHandlerFieldEvaluator.shouldRun",
			),
		};
	}

	private async parseResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorParseParams,
	): Promise<PluginResponseHandlerFieldEvaluatorParseResult> {
		const result = await this.request(
			"plugin",
			"plugin.responseHandlerFieldEvaluator.parse",
			{
				...endpointSelection(params),
				moduleId: params.moduleId,
				field: params.field,
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.value === undefined ? {} : { value: params.value }),
				...(params.traceSessionId === undefined
					? {}
					: { traceSessionId: params.traceSessionId }),
			},
		);
		const object = requireObject(
			result,
			"plugin.responseHandlerFieldEvaluator.parse",
		);
		const softFail = optionalBoolean(
			object,
			"softFail",
			"plugin.responseHandlerFieldEvaluator.parse",
		);
		return {
			...(object.value === undefined ? {} : { value: object.value }),
			...(softFail === undefined ? {} : { softFail }),
		};
	}

	private async handleResponseHandlerFieldEvaluator(
		params: PluginResponseHandlerFieldEvaluatorHandleParams,
	): Promise<PluginResponseHandlerFieldEvaluatorHandleResult> {
		const result = await this.request(
			"plugin",
			"plugin.responseHandlerFieldEvaluator.handle",
			{
				...endpointSelection(params),
				moduleId: params.moduleId,
				field: params.field,
				...(params.context === undefined ? {} : { context: params.context }),
				...(params.value === undefined ? {} : { value: params.value }),
				...(params.parsed === undefined ? {} : { parsed: params.parsed }),
				...(params.traceSessionId === undefined
					? {}
					: { traceSessionId: params.traceSessionId }),
			},
		);
		const object = requireObject(
			result,
			"plugin.responseHandlerFieldEvaluator.handle",
		);
		return {
			...(object.effect === undefined
				? {}
				: {
						effect: requireResponseHandlerFieldEffect(
							object.effect,
							"plugin.responseHandlerFieldEvaluator.handle.effect",
						),
					}),
		};
	}

	private async callPluginLifecycle(
		params: PluginLifecycleCallParams,
	): Promise<PluginLifecycleCallResult> {
		const result = await this.request("plugin", "plugin.lifecycle.call", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			hook: params.hook,
			...(params.config === undefined ? {} : { config: params.config }),
			...(params.context === undefined ? {} : { context: params.context }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.lifecycle.call");
		return {
			ok: requireBoolean(object, "ok", "plugin.lifecycle.call"),
		};
	}

	private async handlePluginEvent(
		params: PluginHandleEventParams,
	): Promise<PluginHandleEventResult> {
		const result = await this.request("plugin", "plugin.event.handle", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			eventName: params.eventName,
			...(params.payload === undefined ? {} : { payload: params.payload }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.event.handle");
		return {
			handled: requireBoolean(object, "handled", "plugin.event.handle"),
		};
	}

	private async invokePluginModel(
		params: PluginInvokeModelParams,
	): Promise<PluginInvokeModelResult> {
		const result = await this.request("plugin", "plugin.model.invoke", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			modelType: params.modelType,
			...(params.params === undefined ? {} : { params: params.params }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.model.invoke");
		if (!Object.hasOwn(object, "result")) {
			throw decodeError("plugin.model.invoke", "result is required.");
		}
		return {
			result: object.result,
		};
	}

	private async callPluginService(
		params: PluginCallServiceParams,
	): Promise<PluginCallServiceResult> {
		const result = await this.request("plugin", "plugin.service.call", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			serviceType: params.serviceType,
			method: params.method,
			...(params.args === undefined ? {} : { args: params.args }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.service.call");
		return Object.hasOwn(object, "result") ? { result: object.result } : {};
	}

	private async callPluginAppBridge(
		params: PluginCallAppBridgeParams,
	): Promise<PluginCallAppBridgeResult> {
		const result = await this.request("plugin", "plugin.appBridge.call", {
			...endpointSelection(params),
			moduleId: params.moduleId,
			hook: params.hook,
			...(params.context === undefined ? {} : { context: params.context }),
			...(params.traceSessionId === undefined
				? {}
				: { traceSessionId: params.traceSessionId }),
		});
		const object = requireObject(result, "plugin.appBridge.call");
		return Object.hasOwn(object, "result") ? { result: object.result } : {};
	}

	private async request(
		capability: CapabilityName,
		method: RuntimeBrokerCapabilityMethod,
		params?: JsonObject,
	): Promise<JsonValue | undefined> {
		try {
			return await this.invokeRuntime(method, params);
		} catch (error) {
			if (error instanceof CapabilityError) throw error;
			throw new CapabilityError({
				code: "CAPABILITY_REQUEST_FAILED",
				message: error instanceof Error ? error.message : String(error),
				capability,
				method,
			});
		}
	}
}

export type CapabilityRuntimeLike = {
	getService(service: string): unknown;
};

export function getCapabilityRouter(
	runtime: CapabilityRuntimeLike,
): ElizaCapabilityRouter | null {
	const service = runtime.getService(CAPABILITY_ROUTER_SERVICE_TYPE);
	return isElizaCapabilityRouter(service) ? service : null;
}

function isElizaCapabilityRouter(
	service: unknown,
): service is ElizaCapabilityRouter {
	if (typeof service !== "object" || service === null) return false;
	const candidate = service as Partial<ElizaCapabilityRouter>;
	return (
		typeof candidate.availability === "function" &&
		isFileCapability(candidate.fs) &&
		isTerminalCapability(candidate.pty) &&
		isGitCapability(candidate.git) &&
		isLocalModelCapability(candidate.model) &&
		isRemotePluginCapability(candidate.plugin)
	);
}

function isFileCapability(value: unknown): value is FileCapability {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<FileCapability>;
	return (
		typeof candidate.list === "function" &&
		typeof candidate.readText === "function" &&
		typeof candidate.writeText === "function"
	);
}

function isTerminalCapability(value: unknown): value is TerminalCapability {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<TerminalCapability>).runCommand === "function"
	);
}

function isGitCapability(value: unknown): value is GitCapability {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<GitCapability>;
	return (
		typeof candidate.status === "function" &&
		typeof candidate.diff === "function" &&
		typeof candidate.commandRun === "function"
	);
}

function isLocalModelCapability(value: unknown): value is LocalModelCapability {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<LocalModelCapability>).status === "function"
	);
}

function isRemotePluginCapability(
	value: unknown,
): value is RemotePluginCapability {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<RemotePluginCapability>;
	return (
		typeof candidate.listModules === "function" &&
		typeof candidate.invokeAction === "function" &&
		typeof candidate.getProvider === "function" &&
		typeof candidate.callRoute === "function" &&
		typeof candidate.getAsset === "function" &&
		typeof candidate.shouldRunEvaluator === "function" &&
		typeof candidate.prepareEvaluator === "function" &&
		typeof candidate.promptEvaluator === "function" &&
		typeof candidate.processEvaluator === "function" &&
		typeof candidate.shouldRunResponseHandlerEvaluator === "function" &&
		typeof candidate.evaluateResponseHandlerEvaluator === "function" &&
		typeof candidate.shouldRunResponseHandlerFieldEvaluator === "function" &&
		typeof candidate.parseResponseHandlerFieldEvaluator === "function" &&
		typeof candidate.handleResponseHandlerFieldEvaluator === "function" &&
		typeof candidate.callLifecycle === "function" &&
		typeof candidate.handleEvent === "function" &&
		typeof candidate.invokeModel === "function" &&
		typeof candidate.callService === "function" &&
		typeof candidate.callAppBridge === "function"
	);
}

function endpointSelection(params: CapabilityEndpointSelection): JsonObject {
	return params.endpointId === undefined
		? {}
		: { endpointId: params.endpointId };
}

function requireObject(
	value: JsonValue | undefined,
	method: string,
): JsonObject {
	if (isJsonObject(value)) return value;
	throw decodeError(method, "Expected object response.");
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
	object: JsonObject,
	key: string,
	method: string,
): string {
	const value = object[key];
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string.`);
}

function requireNonEmptyString(
	object: JsonObject,
	key: string,
	method: string,
): string {
	const value = requireString(object, key, method);
	if (value.trim().length > 0) return value;
	throw decodeError(method, `${key} must be a non-empty string.`);
}

function optionalString(
	object: JsonObject,
	key: string,
	method: string,
): string | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string when present.`);
}

function optionalNonEmptyString(
	object: JsonObject,
	key: string,
	method: string,
): string | undefined {
	const value = optionalString(object, key, method);
	if (value === undefined) return undefined;
	if (value.trim().length > 0) return value;
	throw decodeError(method, `${key} must be a non-empty string when present.`);
}

function optionalJsonObject(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (isJsonObject(value)) return value;
	throw decodeError(method, `${key} must be an object when present.`);
}

function optionalRemotePluginConfig(
	object: JsonObject,
	key: string,
	method: string,
): RemotePluginConfig | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (!isJsonObject(value)) {
		throw decodeError(method, `${key} must be an object when present.`);
	}
	const config: RemotePluginConfig = {};
	for (const [configKey, configValue] of Object.entries(value)) {
		if (
			typeof configValue === "string" ||
			(typeof configValue === "number" && Number.isFinite(configValue)) ||
			typeof configValue === "boolean" ||
			configValue === null
		) {
			config[configKey] = configValue;
			continue;
		}
		throw decodeError(
			method,
			`${key}.${configKey} must be a string, number, boolean, or null.`,
		);
	}
	return config;
}

function requireJsonObject(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject {
	const value = object[key];
	if (isJsonObject(value)) return value;
	throw decodeError(method, `${key} must be an object.`);
}

function optionalNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number when present.`);
}

function requireNumber(
	object: JsonObject,
	key: string,
	method: string,
): number {
	const value = object[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number.`);
}

function requireObjectArray(
	object: JsonObject,
	key: string,
	method: string,
): JsonObject[] {
	const value = object[key];
	if (
		Array.isArray(value) &&
		value.every((entry): entry is JsonObject => isJsonObject(entry))
	) {
		return value;
	}
	throw decodeError(method, `${key} must be an object array.`);
}

function requireFileStatArray(
	object: JsonObject,
	key: string,
	method: string,
): FileStat[] {
	const value = object[key];
	if (!Array.isArray(value)) {
		throw decodeError(method, `${key} must be an array.`);
	}
	return value.map((entry) => requireFileStat(entry, `${method}.${key}`));
}

function requireFileStat(value: JsonValue, method: string): FileStat {
	const object = requireObject(value, method);
	const kind = requireString(object, "kind", method);
	if (
		kind !== "file" &&
		kind !== "directory" &&
		kind !== "symlink" &&
		kind !== "other"
	) {
		throw decodeError(method, "kind must be a valid file entry kind.");
	}
	const modifiedAt = optionalString(object, "modifiedAt", method);
	const isText = optionalBoolean(object, "isText", method);
	return {
		path: requireString(object, "path", method),
		name: requireString(object, "name", method),
		kind,
		size: requireNumber(object, "size", method),
		...(modifiedAt === undefined ? {} : { modifiedAt }),
		...(isText === undefined ? {} : { isText }),
	};
}

function requireStringArray(
	object: JsonObject,
	key: string,
	method: string,
): string[] {
	const value = object[key];
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}
	throw decodeError(method, `${key} must be a string array.`);
}

function optionalStringArray(
	object: JsonObject,
	key: string,
	method: string,
): string[] | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string")
	) {
		return value;
	}
	throw decodeError(method, `${key} must be a string array when present.`);
}

function optionalStringRecord(
	object: JsonObject,
	key: string,
	method: string,
): Record<string, string> | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (
		isJsonObject(value) &&
		Object.values(value).every((entry) => typeof entry === "string")
	) {
		return value as Record<string, string>;
	}
	throw decodeError(method, `${key} must be a string record when present.`);
}

function nullableNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | null {
	const value = object[key];
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(method, `${key} must be a finite number or null.`);
}

function optionalNullableNumber(
	object: JsonObject,
	key: string,
	method: string,
): number | null | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	throw decodeError(
		method,
		`${key} must be a finite number or null when present.`,
	);
}

function optionalNullableString(
	object: JsonObject,
	key: string,
	method: string,
): string | null | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value === "string") return value;
	throw decodeError(method, `${key} must be a string or null when present.`);
}

function requireBoolean(
	object: JsonObject,
	key: string,
	method: string,
): boolean {
	const value = object[key];
	if (typeof value === "boolean") return value;
	throw decodeError(method, `${key} must be a boolean.`);
}

function optionalBoolean(
	object: JsonObject,
	key: string,
	method: string,
): boolean | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (typeof value === "boolean") return value;
	throw decodeError(method, `${key} must be a boolean when present.`);
}

function requireResponseHandlerFieldEffect(
	value: JsonValue,
	method: string,
): NonNullable<PluginResponseHandlerFieldEvaluatorHandleResult["effect"]> {
	const object = requireObject(value, method);
	const patch = optionalJsonObject(object, "patch", method);
	const preempt =
		object.preempt === undefined
			? undefined
			: requireResponseHandlerFieldPreempt(object.preempt, `${method}.preempt`);
	const debug = optionalStringArray(object, "debug", method);
	return {
		...(patch === undefined ? {} : { patch }),
		...(preempt === undefined ? {} : { preempt }),
		...(debug === undefined ? {} : { debug }),
	};
}

function requireResponseHandlerFieldPreempt(
	value: JsonValue,
	method: string,
): NonNullable<
	NonNullable<
		PluginResponseHandlerFieldEvaluatorHandleResult["effect"]
	>["preempt"]
> {
	const object = requireObject(value, method);
	const mode = requireString(object, "mode", method);
	if (mode !== "ack-and-stop" && mode !== "ignore" && mode !== "direct-reply") {
		throw decodeError(method, "preempt.mode is not supported.");
	}
	return {
		mode,
		reason: requireString(object, "reason", method),
	};
}

function requireGitOperation(
	value: JsonValue | undefined,
	method: string,
): GitOperation {
	const object = requireObject(value, method);
	const status = requireString(object, "status", method);
	if (status !== "running" && status !== "completed" && status !== "failed") {
		throw decodeError(method, "status must be a valid Git operation status.");
	}
	const exitCode = optionalNullableNumber(object, "exitCode", method);
	const signal = optionalNullableString(object, "signal", method);
	const completedAt = optionalString(object, "completedAt", method);
	const error = optionalString(object, "error", method);
	return {
		id: requireString(object, "id", method),
		name: requireString(object, "name", method),
		cwd: requireString(object, "cwd", method),
		command: requireStringArray(object, "command", method),
		status,
		stdout: requireString(object, "stdout", method),
		stderr: requireString(object, "stderr", method),
		...(exitCode === undefined ? {} : { exitCode }),
		...(signal === undefined ? {} : { signal }),
		startedAt: requireString(object, "startedAt", method),
		...(completedAt === undefined ? {} : { completedAt }),
		...(error === undefined ? {} : { error }),
	};
}

function requireRemotePluginModuleArray(
	object: JsonObject,
	key: string,
	method: string,
): RemotePluginModuleManifest[] {
	const value = object[key];
	if (!Array.isArray(value))
		throw decodeError(method, `${key} must be an array.`);
	return value.map((entry) =>
		requireRemotePluginModule(entry, `${method}.${key}`),
	);
}

function requireRemotePluginModule(
	value: JsonValue,
	method: string,
): RemotePluginModuleManifest {
	const object = requireObject(value, method);
	const capabilityEndpointId = optionalString(
		object,
		"capabilityEndpointId",
		method,
	);
	const version = optionalString(object, "version", method);
	const description = optionalString(object, "description", method);
	const config = optionalRemotePluginConfig(object, "config", method);
	const schema = optionalJsonObject(object, "schema", method);
	const actions = optionalArray(
		object,
		"actions",
		method,
		requireRemotePluginAction,
	);
	const providers = optionalArray(
		object,
		"providers",
		method,
		requireRemotePluginProvider,
	);
	const evaluators = optionalArray(
		object,
		"evaluators",
		method,
		requireRemotePluginEvaluator,
	);
	const responseHandlerEvaluators = optionalArray(
		object,
		"responseHandlerEvaluators",
		method,
		requireRemotePluginResponseHandlerEvaluator,
	);
	const responseHandlerFieldEvaluators = optionalArray(
		object,
		"responseHandlerFieldEvaluators",
		method,
		requireRemotePluginResponseHandlerFieldEvaluator,
	);
	const events = optionalArray(
		object,
		"events",
		method,
		requireRemotePluginEvent,
	);
	const models = optionalArray(
		object,
		"models",
		method,
		requireRemotePluginModel,
	);
	const services = optionalArray(
		object,
		"services",
		method,
		requireRemotePluginService,
	);
	const widgets = optionalArray(
		object,
		"widgets",
		method,
		requireRemotePluginWidget,
	);
	const app =
		object.app === undefined
			? undefined
			: requireRemotePluginApp(object.app, `${method}.app`);
	const appBridge =
		object.appBridge === undefined
			? undefined
			: requireRemotePluginAppBridge(object.appBridge, `${method}.appBridge`);
	const lifecycle =
		object.lifecycle === undefined
			? undefined
			: requireRemotePluginLifecycle(object.lifecycle, `${method}.lifecycle`);
	const routes = optionalArray(
		object,
		"routes",
		method,
		requireRemotePluginRoute,
	);
	const views = optionalArray(object, "views", method, requireRemotePluginView);
	const metadata = optionalJsonObject(object, "metadata", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		name: requireNonEmptyString(object, "name", method),
		...(capabilityEndpointId === undefined ? {} : { capabilityEndpointId }),
		...(version === undefined ? {} : { version }),
		...(description === undefined ? {} : { description }),
		...(config === undefined ? {} : { config }),
		...(schema === undefined ? {} : { schema }),
		...(actions === undefined ? {} : { actions }),
		...(providers === undefined ? {} : { providers }),
		...(evaluators === undefined ? {} : { evaluators }),
		...(responseHandlerEvaluators === undefined
			? {}
			: { responseHandlerEvaluators }),
		...(responseHandlerFieldEvaluators === undefined
			? {}
			: { responseHandlerFieldEvaluators }),
		...(events === undefined ? {} : { events }),
		...(models === undefined ? {} : { models }),
		...(services === undefined ? {} : { services }),
		...(widgets === undefined ? {} : { widgets }),
		...(app === undefined ? {} : { app }),
		...(appBridge === undefined ? {} : { appBridge }),
		...(lifecycle === undefined ? {} : { lifecycle }),
		...(routes === undefined ? {} : { routes }),
		...(views === undefined ? {} : { views }),
		...(metadata === undefined ? {} : { metadata }),
	};
}

function optionalArray<T>(
	object: JsonObject,
	key: string,
	method: string,
	decode: (value: JsonValue, method: string) => T,
): T[] | undefined {
	const value = object[key];
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		throw decodeError(method, `${key} must be an array when present.`);
	}
	return value.map((entry) => decode(entry, `${method}.${key}`));
}

function requireRemotePluginAction(
	value: JsonValue,
	method: string,
): RemotePluginActionManifest {
	const object = requireObject(value, method);
	const descriptionCompressed = optionalString(
		object,
		"descriptionCompressed",
		method,
	);
	const similes = optionalStringArray(object, "similes", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		...(descriptionCompressed === undefined ? {} : { descriptionCompressed }),
		...(similes === undefined ? {} : { similes }),
		...(object.parameters === undefined
			? {}
			: { parameters: object.parameters }),
	};
}

function requireRemotePluginProvider(
	value: JsonValue,
	method: string,
): RemotePluginProviderManifest {
	const object = requireObject(value, method);
	const description = optionalString(object, "description", method);
	const descriptionCompressed = optionalString(
		object,
		"descriptionCompressed",
		method,
	);
	const dynamic = optionalBoolean(object, "dynamic", method);
	const isPrivate = optionalBoolean(object, "private", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		...(description === undefined ? {} : { description }),
		...(descriptionCompressed === undefined ? {} : { descriptionCompressed }),
		...(dynamic === undefined ? {} : { dynamic }),
		...(isPrivate === undefined ? {} : { private: isPrivate }),
	};
}

function requireRemotePluginEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginEvaluatorManifest {
	const object = requireObject(value, method);
	const similes = optionalStringArray(object, "similes", method);
	const priority = optionalNumber(object, "priority", method);
	const providers = optionalStringArray(object, "providers", method);
	const modelType = optionalString(object, "modelType", method);
	const hasPrepare = optionalBoolean(object, "hasPrepare", method);
	const hasProcessor = optionalBoolean(object, "hasProcessor", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		prompt: requireNonEmptyString(object, "prompt", method),
		...(similes === undefined ? {} : { similes }),
		...(priority === undefined ? {} : { priority }),
		...(providers === undefined ? {} : { providers }),
		schema: requireJsonObject(object, "schema", method),
		...(modelType === undefined ? {} : { modelType }),
		...(hasPrepare === undefined ? {} : { hasPrepare }),
		...(hasProcessor === undefined ? {} : { hasProcessor }),
	};
}

function requireRemotePluginResponseHandlerEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginResponseHandlerEvaluatorManifest {
	const object = requireObject(value, method);
	const description = optionalString(object, "description", method);
	const priority = optionalNumber(object, "priority", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		...(description === undefined ? {} : { description }),
		...(priority === undefined ? {} : { priority }),
	};
}

function requireRemotePluginResponseHandlerFieldEvaluator(
	value: JsonValue,
	method: string,
): RemotePluginResponseHandlerFieldEvaluatorManifest {
	const object = requireObject(value, method);
	const priority = optionalNumber(object, "priority", method);
	const hasParse = optionalBoolean(object, "hasParse", method);
	const hasHandle = optionalBoolean(object, "hasHandle", method);
	return {
		name: requireNonEmptyString(object, "name", method),
		description: requireNonEmptyString(object, "description", method),
		schema: requireObject(object.schema, `${method}.schema`),
		...(priority === undefined ? {} : { priority }),
		...(hasParse === undefined ? {} : { hasParse }),
		...(hasHandle === undefined ? {} : { hasHandle }),
	};
}

function requireRemotePluginEvent(
	value: JsonValue,
	method: string,
): RemotePluginEventManifest {
	const object = requireObject(value, method);
	return {
		eventName: requireNonEmptyString(object, "eventName", method),
	};
}

function requireRemotePluginModel(
	value: JsonValue,
	method: string,
): RemotePluginModelManifest {
	const object = requireObject(value, method);
	const priority = optionalNumber(object, "priority", method);
	return {
		modelType: requireNonEmptyString(object, "modelType", method),
		...(priority === undefined ? {} : { priority }),
	};
}

function requireRemotePluginService(
	value: JsonValue,
	method: string,
): RemotePluginServiceManifest {
	const object = requireObject(value, method);
	const capabilityDescription = optionalString(
		object,
		"capabilityDescription",
		method,
	);
	const methods = optionalStringArray(object, "methods", method);
	validateRemotePluginServiceMethods(methods, method);
	const config = optionalJsonObject(object, "config", method);
	return {
		serviceType: requireNonEmptyString(object, "serviceType", method),
		...(capabilityDescription === undefined ? {} : { capabilityDescription }),
		...(methods === undefined ? {} : { methods }),
		...(config === undefined ? {} : { config }),
	};
}

const REMOTE_SERVICE_RESERVED_METHODS = new Set([
	"callRemote",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString",
	"toString",
	"valueOf",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
]);

function validateRemotePluginServiceMethods(
	methods: string[] | undefined,
	method: string,
): void {
	if (methods === undefined) return;
	const seen = new Set<string>();
	for (const serviceMethod of methods) {
		if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(serviceMethod)) {
			throw decodeError(
				method,
				"methods must contain valid JavaScript method identifiers.",
			);
		}
		if (seen.has(serviceMethod)) {
			throw decodeError(
				method,
				"methods must not contain duplicate method names.",
			);
		}
		seen.add(serviceMethod);
		if (REMOTE_SERVICE_RESERVED_METHODS.has(serviceMethod)) {
			throw decodeError(
				method,
				"methods must not include reserved local service method names.",
			);
		}
	}
}

function requireRemotePluginWidget(
	value: JsonValue,
	method: string,
): RemotePluginWidgetManifest {
	const object = requireObject(value, method);
	const slot = requireString(object, "slot", method);
	if (
		slot !== "chat-sidebar" &&
		slot !== "chat-inline" &&
		slot !== "wallet" &&
		slot !== "browser" &&
		slot !== "heartbeats" &&
		slot !== "character" &&
		slot !== "settings" &&
		slot !== "nav-page" &&
		slot !== "automations"
	) {
		throw decodeError(method, "slot must be a valid plugin widget slot.");
	}
	const pluginId = optionalNonEmptyString(object, "pluginId", method);
	const icon = optionalString(object, "icon", method);
	const order = optionalNumber(object, "order", method);
	const defaultEnabled = optionalBoolean(object, "defaultEnabled", method);
	const navGroup = optionalString(object, "navGroup", method);
	const developerOnly = optionalBoolean(object, "developerOnly", method);
	const componentExport = optionalString(object, "componentExport", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		...(pluginId === undefined ? {} : { pluginId }),
		slot,
		label: requireNonEmptyString(object, "label", method),
		...(icon === undefined ? {} : { icon }),
		...(order === undefined ? {} : { order }),
		...(defaultEnabled === undefined ? {} : { defaultEnabled }),
		...(navGroup === undefined ? {} : { navGroup }),
		...(developerOnly === undefined ? {} : { developerOnly }),
		...(componentExport === undefined ? {} : { componentExport }),
	};
}

function requireRemotePluginApp(
	value: JsonValue,
	method: string,
): RemotePluginAppManifest {
	const object = requireObject(value, method);
	const displayName = optionalNonEmptyString(object, "displayName", method);
	const category = optionalString(object, "category", method);
	const launchType = optionalString(object, "launchType", method);
	const launchUrl = optionalNullableString(object, "launchUrl", method);
	if (typeof launchUrl === "string") {
		validateRemotePluginBrowserUrl(launchUrl, "launchUrl", method);
	}
	const icon = optionalNullableString(object, "icon", method);
	const capabilities = optionalStringArray(object, "capabilities", method);
	const minPlayers = optionalNullableNumber(object, "minPlayers", method);
	const maxPlayers = optionalNullableNumber(object, "maxPlayers", method);
	const runtimePlugin = optionalString(object, "runtimePlugin", method);
	const viewer =
		object.viewer === undefined
			? undefined
			: requireRemotePluginAppViewer(object.viewer, `${method}.viewer`);
	const session =
		object.session === undefined
			? undefined
			: requireRemotePluginAppSession(object.session, `${method}.session`);
	const bridgeExport = optionalString(object, "bridgeExport", method);
	const uiExtension =
		object.uiExtension === undefined
			? undefined
			: requireRemotePluginAppUiExtension(
					object.uiExtension,
					`${method}.uiExtension`,
				);
	const developerOnly = optionalBoolean(object, "developerOnly", method);
	const visibleInAppStore = optionalBoolean(
		object,
		"visibleInAppStore",
		method,
	);
	const navTabs = optionalArray(
		object,
		"navTabs",
		method,
		requireRemotePluginAppNavTab,
	);
	return {
		...(displayName === undefined ? {} : { displayName }),
		...(category === undefined ? {} : { category }),
		...(launchType === undefined ? {} : { launchType }),
		...(launchUrl === undefined ? {} : { launchUrl }),
		...(icon === undefined ? {} : { icon }),
		...(capabilities === undefined ? {} : { capabilities }),
		...(minPlayers === undefined ? {} : { minPlayers }),
		...(maxPlayers === undefined ? {} : { maxPlayers }),
		...(runtimePlugin === undefined ? {} : { runtimePlugin }),
		...(viewer === undefined ? {} : { viewer }),
		...(session === undefined ? {} : { session }),
		...(bridgeExport === undefined ? {} : { bridgeExport }),
		...(uiExtension === undefined ? {} : { uiExtension }),
		...(developerOnly === undefined ? {} : { developerOnly }),
		...(visibleInAppStore === undefined ? {} : { visibleInAppStore }),
		...(navTabs === undefined ? {} : { navTabs }),
	};
}

function requireRemotePluginAppViewer(
	value: JsonValue,
	method: string,
): RemotePluginAppViewerManifest {
	const object = requireObject(value, method);
	const embedParams = optionalStringRecord(object, "embedParams", method);
	const postMessageAuth = optionalBoolean(object, "postMessageAuth", method);
	const sandbox = optionalString(object, "sandbox", method);
	const url = requireNonEmptyString(object, "url", method);
	validateRemotePluginBrowserUrl(url, "url", method);
	return {
		url,
		...(embedParams === undefined ? {} : { embedParams }),
		...(postMessageAuth === undefined ? {} : { postMessageAuth }),
		...(sandbox === undefined ? {} : { sandbox }),
	};
}

function validateRemotePluginBrowserUrl(
	value: string,
	key: string,
	method: string,
): void {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new Error("invalid protocol");
		}
		if (parsed.username || parsed.password) {
			throw new Error("credentials are not allowed");
		}
	} catch {
		throw decodeError(
			method,
			`${key} must be an absolute http(s) URL without embedded credentials.`,
		);
	}
}

function requireRemotePluginAppSession(
	value: JsonValue,
	method: string,
): RemotePluginAppSessionManifest {
	const object = requireObject(value, method);
	const mode = requireString(object, "mode", method);
	if (
		mode !== "viewer" &&
		mode !== "spectate-and-steer" &&
		mode !== "external"
	) {
		throw decodeError(method, "mode must be a valid plugin app session mode.");
	}
	const features = optionalStringArray(object, "features", method);
	if (
		features?.some(
			(feature) =>
				feature !== "commands" &&
				feature !== "telemetry" &&
				feature !== "pause" &&
				feature !== "resume" &&
				feature !== "suggestions",
		)
	) {
		throw decodeError(
			method,
			"features must be valid plugin app session features.",
		);
	}
	return {
		mode,
		...(features === undefined
			? {}
			: {
					features: features as RemotePluginAppSessionManifest["features"],
				}),
	};
}

function requireRemotePluginAppUiExtension(
	value: JsonValue,
	method: string,
): NonNullable<RemotePluginAppManifest["uiExtension"]> {
	const object = requireObject(value, method);
	const detailPanelId = optionalString(object, "detailPanelId", method);
	return {
		...(detailPanelId === undefined ? {} : { detailPanelId }),
	};
}

function requireRemotePluginAppNavTab(
	value: JsonValue,
	method: string,
): RemotePluginAppNavTabManifest {
	const object = requireObject(value, method);
	const icon = optionalString(object, "icon", method);
	const order = optionalNumber(object, "order", method);
	const developerOnly = optionalBoolean(object, "developerOnly", method);
	const group = optionalString(object, "group", method);
	const componentExport = optionalString(object, "componentExport", method);
	const path = requireNonEmptyString(object, "path", method);
	validateRemotePluginPath(path, "path", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		label: requireNonEmptyString(object, "label", method),
		...(icon === undefined ? {} : { icon }),
		path,
		...(order === undefined ? {} : { order }),
		...(developerOnly === undefined ? {} : { developerOnly }),
		...(group === undefined ? {} : { group }),
		...(componentExport === undefined ? {} : { componentExport }),
	};
}

function requireRemotePluginAppBridge(
	value: JsonValue,
	method: string,
): RemotePluginAppBridgeManifest {
	const object = requireObject(value, method);
	const hooks = requireStringArray(object, "hooks", method);
	if (hooks.length === 0) {
		throw decodeError(method, "hooks must not be empty.");
	}
	if (hooks.some((hook) => !isRemotePluginAppBridgeHook(hook))) {
		throw decodeError(method, "hooks must be valid plugin app bridge hooks.");
	}
	return {
		hooks: hooks as RemotePluginAppBridgeHook[],
	};
}

function isRemotePluginAppBridgeHook(
	value: string,
): value is RemotePluginAppBridgeHook {
	return (
		value === "prepareLaunch" ||
		value === "resolveViewerAuthMessage" ||
		value === "ensureRuntimeReady" ||
		value === "collectLaunchDiagnostics" ||
		value === "resolveLaunchSession" ||
		value === "refreshRunSession" ||
		value === "stopRun" ||
		value === "handleAppRoutes"
	);
}

function requireRemotePluginLifecycle(
	value: JsonValue,
	method: string,
): RemotePluginLifecycleManifest {
	const object = requireObject(value, method);
	const hooks = requireStringArray(object, "hooks", method);
	if (hooks.length === 0) {
		throw decodeError(method, "hooks must not be empty.");
	}
	if (hooks.some((hook) => !isRemotePluginLifecycleHook(hook))) {
		throw decodeError(method, "hooks must be valid plugin lifecycle hooks.");
	}
	return {
		hooks: hooks as RemotePluginLifecycleHook[],
	};
}

function isRemotePluginLifecycleHook(
	value: string,
): value is RemotePluginLifecycleHook {
	return value === "init" || value === "dispose" || value === "applyConfig";
}

function requireRemotePluginRoute(
	value: JsonValue,
	method: string,
): RemotePluginRouteManifest {
	const object = requireObject(value, method);
	const routeMethod = requireString(object, "method", method);
	if (
		routeMethod !== "GET" &&
		routeMethod !== "POST" &&
		routeMethod !== "PUT" &&
		routeMethod !== "PATCH" &&
		routeMethod !== "DELETE" &&
		routeMethod !== "STATIC"
	) {
		throw decodeError(method, "method must be a valid plugin route method.");
	}
	const name = optionalString(object, "name", method);
	const isPublic = optionalBoolean(object, "public", method);
	const description = optionalString(object, "description", method);
	const path = requireNonEmptyString(object, "path", method);
	validateRemotePluginPath(path, "path", method);
	return {
		method: routeMethod,
		path,
		...(name === undefined ? {} : { name }),
		...(isPublic === undefined ? {} : { public: isPublic }),
		...(description === undefined ? {} : { description }),
	};
}

function validateRemotePluginPath(
	value: string,
	key: string,
	method: string,
): void {
	if (
		!value.startsWith("/") ||
		value.startsWith("//") ||
		value.includes("?") ||
		value.includes("#") ||
		value.includes("\\") ||
		/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
	) {
		throw decodeError(
			method,
			`${key} must be an absolute app path without URL scheme, query, hash, or backslash.`,
		);
	}
	const segments = value === "/" ? [] : value.split("/").slice(1);
	if (
		segments.some(
			(segment) => segment === "." || segment === ".." || !segment,
		)
	) {
		throw decodeError(
			method,
			`${key} must not contain empty, current-directory, or parent-directory segments.`,
		);
	}
}

function requireRemotePluginView(
	value: JsonValue,
	method: string,
): RemotePluginViewManifest {
	const object = requireObject(value, method);
	const viewType = optionalString(object, "viewType", method);
	if (viewType !== undefined && viewType !== "gui" && viewType !== "tui") {
		throw decodeError(method, "viewType must be gui or tui when present.");
	}
	const bundlePath = optionalNonEmptyString(object, "bundlePath", method);
	const bundleUrl = optionalNonEmptyString(object, "bundleUrl", method);
	if (bundlePath !== undefined) {
		validateRemotePluginAssetPath(bundlePath, "bundlePath", method);
	}
	if (bundleUrl !== undefined) {
		validateRemotePluginBundleUrl(bundleUrl, "bundleUrl", method);
	}
	const contentType = optionalString(object, "contentType", method);
	const integrity = optionalString(object, "integrity", method);
	return {
		id: requireNonEmptyString(object, "id", method),
		label: requireNonEmptyString(object, "label", method),
		...(viewType === undefined ? {} : { viewType }),
		...(bundlePath === undefined ? {} : { bundlePath }),
		...(bundleUrl === undefined ? {} : { bundleUrl }),
		...(contentType === undefined ? {} : { contentType }),
		...(integrity === undefined ? {} : { integrity }),
	};
}

function validateRemotePluginBundleUrl(
	value: string,
	key: string,
	method: string,
): void {
	if (value.startsWith("/")) {
		validateRemotePluginPath(value, key, method);
		return;
	}
	validateRemotePluginBrowserUrl(value, key, method);
}

function validateRemotePluginAssetPath(
	value: string,
	key: string,
	method: string,
): void {
	const path = value.trim();
	if (
		!path ||
		path.includes("?") ||
		path.includes("#") ||
		path.includes("\\") ||
		path.startsWith("//") ||
		/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(path)
	) {
		throw decodeError(
			method,
			`${key} must be an asset path without query, hash, URL scheme, or backslash.`,
		);
	}
	const segments = path.replace(/^\/+/, "").split("/");
	if (
		segments.length === 0 ||
		segments.some((segment) => !segment || segment === "." || segment === "..")
	) {
		throw decodeError(
			method,
			`${key} must not contain empty, current-directory, or parent-directory segments.`,
		);
	}
}

function requirePluginActionResult(
	value: JsonValue | undefined,
	method: string,
): PluginInvokeActionResult {
	const object = requireObject(value, method);
	const text = optionalString(object, "text", method);
	const actions = optionalStringArray(object, "actions", method);
	const values = optionalJsonObject(object, "values", method);
	const data = optionalJsonObject(object, "data", method);
	return {
		...(text === undefined ? {} : { text }),
		...(actions === undefined ? {} : { actions }),
		...(values === undefined ? {} : { values }),
		...(data === undefined ? {} : { data }),
	};
}

function requirePluginProviderResult(
	value: JsonValue | undefined,
	method: string,
): PluginGetProviderResult {
	const object = requireObject(value, method);
	const text = optionalString(object, "text", method);
	const values = optionalJsonObject(object, "values", method);
	const data = optionalJsonObject(object, "data", method);
	return {
		...(text === undefined ? {} : { text }),
		...(values === undefined ? {} : { values }),
		...(data === undefined ? {} : { data }),
	};
}

function decodeError(method: string, message: string): CapabilityError {
	return new CapabilityError({
		code: "CAPABILITY_DECODE_FAILED",
		message,
		method,
	});
}

function paramsToDetails(params: FileListParams | undefined): JsonObject {
	if (!params) return {};
	return {
		...(params.path === undefined ? {} : { path: params.path }),
		...(params.rootId === undefined ? {} : { rootId: params.rootId }),
		...(params.limit === undefined ? {} : { limit: params.limit }),
		...(params.includeHidden === undefined
			? {}
			: { includeHidden: params.includeHidden }),
		...(params.ignore === undefined ? {} : { ignore: params.ignore }),
	};
}
