/**
 * Worker sandbox filesystem: fail-closed path checks plus O_NOFOLLOW
 * open so a symlink swapped in after lstat/realpath cannot escape
 * `statePath`. The worker entry is the only production caller.
 */

import { constants, symlinkSync, unlinkSync } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import nodePath from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export type SandboxFsOperation = "read" | "write";

export interface SandboxFsOptions {
	statePath: string;
	granted: boolean;
	declared: ReadonlySet<SandboxFsOperation>;
}

export interface SandboxFs {
	readFile(path: string): Promise<string>;
	writeFile(path: string, content: string): Promise<void>;
}

function errnoCode(error: unknown): string {
	return error && typeof error === "object" && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: "";
}

function isNofollowDenied(error: unknown): boolean {
	const code = errnoCode(error);
	return code === "ELOOP" || code === "EPERM" || code === "EINVAL";
}

function isInsideRoot(root: string, candidate: string): boolean {
	const relative = nodePath.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith("..") && !nodePath.isAbsolute(relative))
	);
}

function sandboxEscapeError(candidate: string, statePath: string): Error {
	return new Error(
		`fs access to ${candidate} escapes the sandbox statePath (${statePath})`,
	);
}

/**
 * Test-only seam: after path validation, replace the target with a symlink
 * so the following `O_NOFOLLOW` open must fail closed. Production never
 * sets `ELIZA_APP_WORKER_FS_TOCTOU_HOOK`.
 */
export function applyToctouTestHook(target: string): void {
	if (process.env.ELIZA_APP_WORKER_FS_TOCTOU_HOOK !== "1") return;
	const dest = process.env.ELIZA_APP_WORKER_FS_TOCTOU_TARGET;
	if (!dest) return;
	try {
		unlinkSync(target);
	} catch (error) {
		// error-policy:J3 missing target is still swapped to the hostile symlink
		if (errnoCode(error) !== "ENOENT") throw error;
	}
	symlinkSync(dest, target);
}

export async function resolveSandboxPath(
	absolutePath: string,
	operation: SandboxFsOperation,
	options: SandboxFsOptions,
): Promise<string> {
	if (!options.granted) {
		throw new Error(
			"fs access not granted by user (sandbox: grantedNamespaces does not include 'fs')",
		);
	}
	if (!options.declared.has(operation)) {
		throw new Error(`fs.${operation} access not allowed by manifest`);
	}
	const statePath = nodePath.resolve(options.statePath);
	const resolved = nodePath.resolve(absolutePath);
	let rootReal: string;
	try {
		rootReal = await realpath(statePath);
	} catch (error) {
		// error-policy:J3 untrusted-input sanitizing — a missing sandbox root
		// cannot authorize any path; do not fall back to lexical-only allow.
		if (errnoCode(error) === "ENOENT") {
			throw new Error(
				`fs access requires an existing statePath (${statePath})`,
			);
		}
		throw error;
	}

	if (!isInsideRoot(rootReal, resolved) && !isInsideRoot(statePath, resolved)) {
		throw sandboxEscapeError(resolved, statePath);
	}

	try {
		const stat = await lstat(resolved);
		if (stat.isSymbolicLink()) {
			throw sandboxEscapeError(resolved, statePath);
		}
		const canonical = await realpath(resolved);
		if (!isInsideRoot(rootReal, canonical)) {
			throw sandboxEscapeError(canonical, statePath);
		}
		return canonical;
	} catch (error) {
		if (
			error instanceof Error &&
			/escapes the sandbox statePath/.test(error.message)
		) {
			throw error;
		}
		if (errnoCode(error) === "ENOENT" && operation === "read") {
			// error-policy:J3 untrusted-input sanitizing — missing files stay
			// inside the lexical/real root; the subsequent read surfaces ENOENT.
			if (
				!isInsideRoot(rootReal, resolved) &&
				!isInsideRoot(statePath, resolved)
			) {
				throw sandboxEscapeError(resolved, statePath);
			}
			return resolved;
		}
		if (errnoCode(error) === "ENOENT" && operation === "write") {
			const parent = nodePath.dirname(resolved);
			try {
				const parentStat = await lstat(parent);
				if (parentStat.isSymbolicLink()) {
					throw sandboxEscapeError(resolved, statePath);
				}
				const parentReal = await realpath(parent);
				if (!isInsideRoot(rootReal, parentReal)) {
					throw sandboxEscapeError(resolved, statePath);
				}
				return nodePath.join(parentReal, nodePath.basename(resolved));
			} catch (parentError) {
				if (
					parentError instanceof Error &&
					/escapes the sandbox statePath/.test(parentError.message)
				) {
					throw parentError;
				}
				// error-policy:J3 untrusted-input sanitizing — a missing parent
				// is created only when the write target is still inside the root.
				if (errnoCode(parentError) === "ENOENT") {
					if (
						!isInsideRoot(rootReal, resolved) &&
						!isInsideRoot(statePath, resolved)
					) {
						throw sandboxEscapeError(resolved, statePath);
					}
					return resolved;
				}
				throw parentError;
			}
		}
		throw error;
	}
}

export async function openSandboxFile(
	path: string,
	operation: SandboxFsOperation,
	options: SandboxFsOptions,
): Promise<Awaited<ReturnType<typeof open>>> {
	const target = await resolveSandboxPath(path, operation, options);
	applyToctouTestHook(target);
	if (operation === "write") {
		await mkdir(nodePath.dirname(target), { recursive: true });
	}
	const flags =
		operation === "read"
			? constants.O_RDONLY | NOFOLLOW
			: constants.O_WRONLY | constants.O_CREAT | NOFOLLOW;
	try {
		const handle = await open(target, flags);
		const stat = await handle.stat();
		if (!stat.isFile()) {
			await handle.close();
			throw sandboxEscapeError(target, options.statePath);
		}
		return handle;
	} catch (error) {
		if (
			error instanceof Error &&
			/escapes the sandbox statePath/.test(error.message)
		) {
			throw error;
		}
		// error-policy:J3 untrusted-input sanitizing — a symlink at use time
		// (including a swap after lstat) is an explicit escape, never a follow.
		if (isNofollowDenied(error)) {
			throw sandboxEscapeError(target, options.statePath);
		}
		throw error;
	}
}

export function createSandboxFs(options: SandboxFsOptions): SandboxFs {
	return {
		async readFile(path: string): Promise<string> {
			const handle = await openSandboxFile(path, "read", options);
			try {
				return await handle.readFile("utf8");
			} finally {
				await handle.close();
			}
		},
		async writeFile(path: string, content: string): Promise<void> {
			const handle = await openSandboxFile(path, "write", options);
			try {
				await handle.writeFile(content, "utf8");
			} finally {
				await handle.close();
			}
		},
	};
}
