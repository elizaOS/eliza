/**
 * Built-in VFS shell stub.
 *
 * Local-safe mode is meant to route VFS-scoped shell commands through a
 * SandboxManager. When no SandboxManager is available, this stub is the
 * last-resort fallback: it returns a refusal rather than touching the host.
 *
 * A previous version of this file was lost during refactoring. This stub
 * preserves the import surface used by `shell-execution-router.ts` so the
 * agent typechecks cleanly. The actual built-in shell semantics will be
 * restored in a follow-up.
 */

import type { ShellResult } from "./shell-execution-router.ts";

const VFS_URI_PREFIX = "vfs://";

export function isVfsUri(value: string | undefined): value is string {
	return typeof value === "string" && value.startsWith(VFS_URI_PREFIX);
}

export interface VfsBuiltinShellRequest {
	readonly cwdUri: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly timeoutMs?: number;
}

export async function runVfsBuiltinShell(
	_req: VfsBuiltinShellRequest,
): Promise<ShellResult> {
	return {
		exitCode: 1,
		stdout: "",
		stderr:
			"[vfs-builtin-shell] no SandboxManager available and the built-in VFS shell is not implemented in this build. Configure a sandbox or run in local-yolo mode.",
		durationMs: 0,
		sandbox: "vfs",
	};
}
