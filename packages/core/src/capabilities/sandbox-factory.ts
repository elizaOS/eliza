import type { Service } from "../types/service";

/**
 * Service-type slot a remote-sandbox vendor plugin registers under to provide a
 * concrete {@link E2BSandboxFactory} to the host capability router. The router
 * (`packages/agent/src/services/e2b-capability-router.ts`) owns the
 * provider-neutral routing + the eliza-cloud / home HTTP providers; the E2B
 * (`e2b.dev`) SDK backend lives in `@elizaos/plugin-e2b-sandbox` and is only
 * selectable when that plugin has registered this service.
 */
export const E2B_SANDBOX_FACTORY_SERVICE_TYPE = "e2b-sandbox-factory" as const;

export interface SandboxEntryInfo {
	path: string;
	name: string;
	type: "file" | "dir" | "symlink" | "other" | (string & {});
	size: number;
	mode?: number;
	permissions?: string;
	owner?: string;
	group?: string;
	modifiedTime?: Date;
	symlinkTarget?: string;
}

export interface SandboxCommandRunOptions {
	cwd?: string;
	timeoutMs?: number;
	requestTimeoutMs?: number;
	envs?: Record<string, string>;
	background?: false;
}

export interface SandboxCommandResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface SandboxFileCapability {
	list(
		path: string,
		opts?: { depth?: number; requestTimeoutMs?: number },
	): Promise<SandboxEntryInfo[]>;
	read(
		path: string,
		opts?: { format?: "text" | "bytes"; requestTimeoutMs?: number },
	): Promise<string | Uint8Array>;
	write(
		path: string,
		data: string,
		opts?: { requestTimeoutMs?: number },
	): Promise<{ path: string; name: string }>;
}

export interface SandboxCommandCapability {
	run(
		cmd: string,
		opts?: SandboxCommandRunOptions,
	): Promise<SandboxCommandResult>;
}

/**
 * Transport-neutral handle to a live remote sandbox. Implemented by every
 * backend (e2b SDK, eliza-cloud / home HTTP runners). The router drives
 * filesystem, terminal, and git capabilities exclusively through this surface.
 */
export interface E2BSandboxClient {
	readonly sandboxId: string;
	readonly workspacePrepared?: boolean;
	readonly files: SandboxFileCapability;
	readonly commands: SandboxCommandCapability;
	kill(opts?: { requestTimeoutMs?: number }): Promise<void>;
}

/**
 * The subset of the router's runner config a raw sandbox backend needs to
 * create / connect a sandbox. The router's full `E2BRemoteRunnerConfig` is a
 * superset of this, so it is directly assignable here.
 */
export interface E2BSandboxCreateOptions {
	apiKey?: string;
	accessToken?: string;
	domain?: string;
	sandboxId?: string;
	template?: string;
	envs: Record<string, string>;
	metadata: Record<string, string>;
	timeoutMs: number;
	requestTimeoutMs: number;
	allowInternetAccess: boolean;
}

/** A backend able to materialise an {@link E2BSandboxClient}. */
export interface E2BSandboxFactory {
	create(options: E2BSandboxCreateOptions): Promise<E2BSandboxClient>;
}

/**
 * Shape of the service a sandbox-vendor plugin registers under
 * {@link E2B_SANDBOX_FACTORY_SERVICE_TYPE}. Kept as an interface (not a runtime
 * class) so this contract stays browser-safe; the concrete class lives in the
 * plugin and `extends Service implements E2BSandboxFactory`.
 */
export interface E2BSandboxFactoryService extends Service, E2BSandboxFactory {}

export function normalizeSandboxEntryType(
	type: string | undefined,
): SandboxEntryInfo["type"] {
	if (type === "dir" || type === "directory") return "dir";
	if (type === "file") return "file";
	if (type === "symlink") return "symlink";
	return "other";
}
