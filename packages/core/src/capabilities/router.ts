/** Capability routing and availability; imported directly by internal consumers. */

import type { JsonObject, JsonValue } from "../types/primitives";
import {
	normalizeWorkspaceDeltaReceipt,
	type WorkspaceDeltaReceipt,
} from "../types/workspace-delta";
import {
	decodeError,
	endpointSelection,
	isRemotePluginAppBridgeHook,
	isRemotePluginLifecycleHook,
	nullableNumber,
	optionalBoolean,
	optionalJsonObject,
	optionalNumber,
	optionalString,
	optionalStringRecord,
	paramsToDetails,
	requireBoolean,
	requireFileStatArray,
	requireGitOperation,
	requireNonEmptyString,
	requireNumber,
	requireObject,
	requireObjectArray,
	requirePluginActionResult,
	requirePluginProviderResult,
	requireRemotePluginModuleArray,
	requireResponseHandlerFieldEffect,
	requireString,
	validateBase64String,
	validateHeaderRecord,
	validateHeaderSafeString,
	validateHttpStatusCode,
	validateRemotePluginAssetPath,
	validateRemotePluginCallTarget,
	validateRemotePluginPath,
	validateRemotePluginRouteMethod,
	validateRemotePluginServiceMethods,
	validateRouteQueryRecord,
} from "./decoder.js";
import {
	CAPABILITY_ROUTER_SERVICE_TYPE,
	type CapabilityAvailability,
	type CapabilityEnvironment,
	CapabilityError,
	type CapabilityName,
	type ElizaCapabilityRouter,
	type FileCapability,
	type FileListParams,
	type FileListResult,
	type FileReadTextParams,
	type FileReadTextResult,
	type FileWriteTextParams,
	type FileWriteTextResult,
	type GitCapability,
	type GitCommandRunParams,
	type GitCommandRunResult,
	type GitDiffParams,
	type GitDiffResult,
	type GitStatusParams,
	type GitStatusResult,
	type LocalModelCapability,
	type LocalModelStatusParams,
	type LocalModelStatusResult,
	type PluginCallAppBridgeParams,
	type PluginCallAppBridgeResult,
	type PluginCallRouteParams,
	type PluginCallRouteResult,
	type PluginCallServiceParams,
	type PluginCallServiceResult,
	type PluginEvaluatorPrepareParams,
	type PluginEvaluatorPrepareResult,
	type PluginEvaluatorProcessParams,
	type PluginEvaluatorProcessResult,
	type PluginEvaluatorPromptParams,
	type PluginEvaluatorPromptResult,
	type PluginEvaluatorShouldRunParams,
	type PluginEvaluatorShouldRunResult,
	type PluginGetAssetParams,
	type PluginGetAssetResult,
	type PluginGetProviderParams,
	type PluginGetProviderResult,
	type PluginHandleEventParams,
	type PluginHandleEventResult,
	type PluginInvokeActionParams,
	type PluginInvokeActionResult,
	type PluginInvokeModelParams,
	type PluginInvokeModelResult,
	type PluginLifecycleCallParams,
	type PluginLifecycleCallResult,
	type PluginListModulesParams,
	type PluginListModulesResult,
	type PluginResponseHandlerEvaluatorEvaluateParams,
	type PluginResponseHandlerEvaluatorEvaluateResult,
	type PluginResponseHandlerEvaluatorShouldRunParams,
	type PluginResponseHandlerEvaluatorShouldRunResult,
	type PluginResponseHandlerFieldEvaluatorHandleParams,
	type PluginResponseHandlerFieldEvaluatorHandleResult,
	type PluginResponseHandlerFieldEvaluatorParseParams,
	type PluginResponseHandlerFieldEvaluatorParseResult,
	type PluginResponseHandlerFieldEvaluatorShouldRunParams,
	type PluginResponseHandlerFieldEvaluatorShouldRunResult,
	type RemotePluginCapability,
	type RuntimeBrokerCapabilityMethod,
	type RuntimeBrokerCapabilityRouterOptions,
	type RuntimeBrokerInvoke,
	type TerminalCapability,
	type TerminalRunParams,
	type TerminalRunResult,
} from "./protocol.js";

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
		if (requireBoolean(object, "truncated", "fs.readText")) {
			throw new CapabilityError({
				code: "CAPABILITY_REQUEST_FAILED",
				capability: "fs",
				method: "fs.readText",
				message: "fs.readText endpoint returned partial content.",
			});
		}
		return {
			path: requireString(object, "path", "fs.readText"),
			text: requireString(object, "text", "fs.readText"),
			size: requireNumber(object, "size", "fs.readText"),
			truncated: false,
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
		const requestedPath = optionalString(
			object,
			"requestedPath",
			"fs.writeText",
		);
		return {
			path: requireString(object, "path", "fs.writeText"),
			bytesWritten: requireNumber(object, "bytesWritten", "fs.writeText"),
			...(requestedPath === undefined ? {} : { requestedPath }),
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
		const workspaceExecution = optionalJsonObject(
			object,
			"workspaceExecution",
			"pty.command.run",
		);
		let normalizedWorkspaceExecution: TerminalRunResult["workspaceExecution"];
		if (workspaceExecution) {
			const unexpectedWorkspaceKeys = Object.keys(workspaceExecution).filter(
				(key) => !["root", "rootId", "executionDomainId"].includes(key),
			);
			if (unexpectedWorkspaceKeys.length > 0) {
				throw decodeError(
					"pty.command.run",
					`workspaceExecution has unexpected fields: ${unexpectedWorkspaceKeys.join(", ")}.`,
				);
			}
			const root = requireNonEmptyString(
				workspaceExecution,
				"root",
				"pty.command.run.workspaceExecution",
			);
			const rootId = requireString(
				workspaceExecution,
				"rootId",
				"pty.command.run.workspaceExecution",
			);
			const executionDomainId = requireString(
				workspaceExecution,
				"executionDomainId",
				"pty.command.run.workspaceExecution",
			);
			if (
				root.trim() !== root ||
				/[\0\r\n]/.test(root) ||
				!/^[a-f0-9]{64}$/.test(rootId) ||
				!/^[a-f0-9]{64}$/.test(executionDomainId)
			) {
				throw decodeError(
					"pty.command.run",
					"workspaceExecution must contain a safe root and canonical opaque identities.",
				);
			}
			normalizedWorkspaceExecution = { root, rootId, executionDomainId };
		}
		let workspaceDeltaReceipt: WorkspaceDeltaReceipt | undefined;
		if (object.workspaceDeltaReceipt !== undefined) {
			try {
				workspaceDeltaReceipt = normalizeWorkspaceDeltaReceipt(
					object.workspaceDeltaReceipt,
				);
			} catch (error) {
				throw decodeError(
					"pty.command.run",
					`workspaceDeltaReceipt is invalid: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (
				!normalizedWorkspaceExecution ||
				workspaceDeltaReceipt.scope.root !==
					normalizedWorkspaceExecution.root ||
				workspaceDeltaReceipt.scope.rootId !==
					normalizedWorkspaceExecution.rootId ||
				workspaceDeltaReceipt.scope.executionDomainId !==
					normalizedWorkspaceExecution.executionDomainId
			) {
				throw decodeError(
					"pty.command.run",
					"workspaceDeltaReceipt must bind exactly to the attested workspaceExecution scope.",
				);
			}
		}
		return {
			output: requireString(object, "output", "pty.command.run"),
			exitCode: nullableNumber(object, "exitCode", "pty.command.run"),
			timedOut: requireBoolean(object, "timedOut", "pty.command.run"),
			...(normalizedWorkspaceExecution
				? { workspaceExecution: normalizedWorkspaceExecution }
				: {}),
			...(workspaceDeltaReceipt ? { workspaceDeltaReceipt } : {}),
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
			...(params.endpointId === undefined
				? {}
				: { endpointId: params.endpointId }),
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.action.invoke",
		);
		validateRemotePluginCallTarget(
			params.action,
			"action",
			"plugin.action.invoke",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.provider.get",
		);
		validateRemotePluginCallTarget(
			params.provider,
			"provider",
			"plugin.provider.get",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.route.call",
		);
		validateRemotePluginRouteMethod(
			params.method,
			"method",
			"plugin.route.call",
			false,
		);
		validateRemotePluginPath(params.path, "path", "plugin.route.call");
		if (params.headers !== undefined) {
			validateHeaderRecord(params.headers, "headers", "plugin.route.call");
		}
		if (params.query !== undefined) {
			validateRouteQueryRecord(params.query, "query", "plugin.route.call");
		}
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
		if (headers !== undefined) {
			validateHeaderRecord(headers, "headers", "plugin.route.call");
		}
		const status = requireNumber(object, "status", "plugin.route.call");
		validateHttpStatusCode(status, "status", "plugin.route.call");
		return {
			status,
			...(headers === undefined ? {} : { headers }),
			...(object.body === undefined ? {} : { body: object.body }),
		};
	}

	private async getPluginAsset(
		params: PluginGetAssetParams,
	): Promise<PluginGetAssetResult> {
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.asset.get",
		);
		validateRemotePluginAssetPath(params.path, "path", "plugin.asset.get");
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
		const path = requireNonEmptyString(object, "path", "plugin.asset.get");
		validateRemotePluginAssetPath(path, "path", "plugin.asset.get");
		const contentType = requireNonEmptyString(
			object,
			"contentType",
			"plugin.asset.get",
		);
		validateHeaderSafeString(contentType, "contentType", "plugin.asset.get");
		const bodyBase64 = requireString(object, "bodyBase64", "plugin.asset.get");
		validateBase64String(bodyBase64, "bodyBase64", "plugin.asset.get");
		if (integrity !== undefined) {
			validateHeaderSafeString(integrity, "integrity", "plugin.asset.get");
		}
		return {
			path,
			contentType,
			bodyBase64,
			...(integrity === undefined ? {} : { integrity }),
		};
	}

	private async shouldRunPluginEvaluator(
		params: PluginEvaluatorShouldRunParams,
	): Promise<PluginEvaluatorShouldRunResult> {
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.evaluator.shouldRun",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.evaluator.shouldRun",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.evaluator.prepare",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.evaluator.prepare",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.evaluator.prompt",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.evaluator.prompt",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.evaluator.process",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.evaluator.process",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.responseHandlerEvaluator.shouldRun",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.responseHandlerEvaluator.shouldRun",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.responseHandlerEvaluator.evaluate",
		);
		validateRemotePluginCallTarget(
			params.evaluator,
			"evaluator",
			"plugin.responseHandlerEvaluator.evaluate",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.responseHandlerFieldEvaluator.shouldRun",
		);
		validateRemotePluginCallTarget(
			params.field,
			"field",
			"plugin.responseHandlerFieldEvaluator.shouldRun",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.responseHandlerFieldEvaluator.parse",
		);
		validateRemotePluginCallTarget(
			params.field,
			"field",
			"plugin.responseHandlerFieldEvaluator.parse",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.responseHandlerFieldEvaluator.handle",
		);
		validateRemotePluginCallTarget(
			params.field,
			"field",
			"plugin.responseHandlerFieldEvaluator.handle",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.lifecycle.call",
		);
		if (!isRemotePluginLifecycleHook(params.hook)) {
			throw decodeError(
				"plugin.lifecycle.call",
				"hook must be a valid plugin lifecycle hook.",
			);
		}
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.event.handle",
		);
		validateRemotePluginCallTarget(
			params.eventName,
			"eventName",
			"plugin.event.handle",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.model.invoke",
		);
		validateRemotePluginCallTarget(
			params.modelType,
			"modelType",
			"plugin.model.invoke",
		);
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.service.call",
		);
		validateRemotePluginCallTarget(
			params.serviceType,
			"serviceType",
			"plugin.service.call",
		);
		validateRemotePluginServiceMethods([params.method], "plugin.service.call");
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
		validateRemotePluginCallTarget(
			params.moduleId,
			"moduleId",
			"plugin.appBridge.call",
		);
		if (!isRemotePluginAppBridgeHook(params.hook)) {
			throw decodeError(
				"plugin.appBridge.call",
				"hook must be a valid plugin app bridge hook.",
			);
		}
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
			// error-policy:J1 Capability invocation translates implementation
			// failures into the typed capability boundary error.
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
