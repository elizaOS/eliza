/**
 * Transport-neutral remote-runner client contracts used by the host capability
 * router for filesystem, command, and Git operations against Eliza Cloud or a
 * home runner. The interface-only surface remains browser-safe and is
 * re-exported from the capabilities barrel.
 */

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
	timedOut?: boolean;
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
 * Transport-neutral handle to a live remote runner. Implemented by the Eliza
 * Cloud and home HTTP backends. The router drives
 * filesystem, terminal, and git capabilities exclusively through this surface.
 */
export interface RemoteRunnerClient {
	readonly sandboxId: string;
	readonly workspacePrepared?: boolean;
	readonly files: SandboxFileCapability;
	readonly commands: SandboxCommandCapability;
	kill(opts?: { requestTimeoutMs?: number }): Promise<void>;
}

export function normalizeSandboxEntryType(
	type: string | undefined,
): SandboxEntryInfo["type"] {
	if (type === "dir" || type === "directory") return "dir";
	if (type === "file") return "file";
	if (type === "symlink") return "symlink";
	return "other";
}
