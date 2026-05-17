import type { JsonObject, JsonValue } from "../types/primitives";

export const CAPABILITY_ROUTER_SERVICE_TYPE = "capability-router" as const;

export type CapabilityEnvironment =
	| "desktop"
	| "node"
	| "server"
	| "browser"
	| "mobile"
	| "unknown";

export type CapabilityName = "fs" | "pty" | "git" | "model";

export type CapabilityAvailability = {
	environment: CapabilityEnvironment;
	available: boolean;
	capabilities: Record<CapabilityName, boolean>;
	reason?: string;
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

export type FileReadTextParams = {
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

export type TerminalRunParams = {
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

export type GitStatusParams = {
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

export type GitDiffParams = {
	root: string;
	path?: string;
	staged?: boolean;
	traceSessionId?: string;
};

export type GitDiffResult = {
	raw: string;
};

export type GitCommandRunParams = {
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

export interface FileCapability {
	readText(params: FileReadTextParams): Promise<FileReadTextResult>;
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
	status(): Promise<LocalModelStatusResult>;
}

export interface ElizaCapabilityRouter {
	readonly environment: CapabilityEnvironment;
	availability(): Promise<CapabilityAvailability>;
	readonly fs: FileCapability;
	readonly pty: TerminalCapability;
	readonly git: GitCapability;
	readonly model: LocalModelCapability;
}

export type RuntimeBrokerCapabilityMethod =
	| "fs.readText"
	| "pty.command.run"
	| "git.status"
	| "git.diff"
	| "git.command.run"
	| "model.status";

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

	constructor(
		readonly environment: CapabilityEnvironment = "unknown",
		private readonly reason = "Capability router is not available.",
	) {
		this.fs = {
			readText: (params) =>
				this.unavailable("fs", "fs.readText", { path: params.path }),
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
	private readonly invokeRuntime: RuntimeBrokerInvoke;

	constructor(options: RuntimeBrokerCapabilityRouterOptions) {
		this.environment = options.environment ?? "desktop";
		this.invokeRuntime = options.invokeRuntime;
		this.fs = {
			readText: (params) => this.readText(params),
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
			status: () => this.modelStatus(),
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
			},
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
		});
		const object = requireObject(result, "fs.readText");
		return {
			path: requireString(object, "path", "fs.readText"),
			text: requireString(object, "text", "fs.readText"),
			size: requireNumber(object, "size", "fs.readText"),
			truncated: requireBoolean(object, "truncated", "fs.readText"),
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
		});
		const object = requireObject(result, "git.command.run");
		return {
			operation: requireGitOperation(
				object.operation,
				"git.command.run.operation",
			),
		};
	}

	private async modelStatus(): Promise<LocalModelStatusResult> {
		const result = await this.request("model", "model.status");
		const object = requireObject(result, "model.status");
		const provider = optionalString(object, "provider", "model.status");
		return {
			ok: requireBoolean(object, "ok", "model.status"),
			...(provider === undefined ? {} : { provider }),
			raw: object,
		};
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
		isLocalModelCapability(candidate.model)
	);
}

function isFileCapability(value: unknown): value is FileCapability {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as Partial<FileCapability>).readText === "function"
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

function requireStringArray(
	object: JsonObject,
	key: string,
	method: string,
): string[] {
	const value = object[key];
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
		return value;
	}
	throw decodeError(method, `${key} must be a string array.`);
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
	throw decodeError(method, `${key} must be a finite number or null when present.`);
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

function decodeError(method: string, message: string): CapabilityError {
	return new CapabilityError({
		code: "CAPABILITY_DECODE_FAILED",
		message,
		method,
	});
}
