/**
 * Shared path-guard primitives for the mobile filesystem shim.
 *
 * These helpers normalize Node path-like inputs, derive read/write intent, and
 * route filesystem calls through the workspace resolver that blocks traversal
 * and native-binary writes.
 */

import * as realFs from "node:fs";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";

export type FsAccessMode = "read" | "write";
// Intentionally uses `any[]` for parameter contravariance. The wrapper
// generics propagate the real `T` shape to callers; the wrapper body
// re-validates path-like arguments at runtime via `mobileFsPathLikeToString`.
export type AnyFn = (...args: never[]) => unknown;
export type MobileFsGlobals = typeof globalThis & {
	__ELIZA_MOBILE_FS_RESOLVE__?: (
		inputPath: string,
		mode?: FsAccessMode,
	) => string;
};

type MobileFsResolver = NonNullable<
	MobileFsGlobals["__ELIZA_MOBILE_FS_RESOLVE__"]
>;

export function requireMobileFsResolver(moduleName: string): MobileFsResolver {
	const resolver = (globalThis as MobileFsGlobals).__ELIZA_MOBILE_FS_RESOLVE__;
	if (!resolver) {
		throw new Error(
			`${moduleName}: filesystem access before installMobileFsShim()`,
		);
	}
	return resolver;
}

export function mobileFsAccessError(
	path: string,
	message: string,
): NodeJS.ErrnoException {
	const err = new Error(message) as NodeJS.ErrnoException;
	err.code = "EACCES";
	err.path = path;
	return err;
}

export function guardMobileFsWritePath(
	resolved: string,
	originalPath: string,
): void {
	const ext = nodePath.extname(resolved).toLowerCase();
	if (ext === ".so" || ext === ".dylib" || ext === ".node") {
		throw mobileFsAccessError(
			originalPath,
			`mobile-fs-shim: writing native binary files is blocked (${ext})`,
		);
	}
}

export function mobileFsPathLikeToString(
	raw: unknown,
	moduleName: string,
): string | null {
	if (raw instanceof URL) {
		if (raw.protocol !== "file:") {
			throw new Error(
				`${moduleName}: only file: URLs are accepted (${raw.protocol})`,
			);
		}
		return fileURLToPath(raw);
	}
	if (Buffer.isBuffer(raw)) return raw.toString("utf8");
	return typeof raw === "string" ? raw : null;
}

export function modeForMobileFsOpenFlags(flags: unknown): FsAccessMode {
	if (typeof flags === "number") {
		const writeBits =
			realFs.constants.O_WRONLY |
			realFs.constants.O_RDWR |
			realFs.constants.O_APPEND |
			realFs.constants.O_CREAT |
			realFs.constants.O_TRUNC;
		return (flags & writeBits) !== 0 ? "write" : "read";
	}
	if (typeof flags !== "string" || flags.length === 0) return "read";
	return /[wa+]/.test(flags) ? "write" : "read";
}

export function wrapMobileFsPath<T extends AnyFn>(
	moduleName: string,
	fn: T | undefined,
	mode: FsAccessMode,
): T {
	return function wrappedMobileFsPath(
		this: unknown,
		...args: Parameters<T>
	): ReturnType<T> {
		const a: unknown[] = args;
		const pathStr = mobileFsPathLikeToString(a[0], moduleName);
		if (pathStr !== null) {
			const resolved = requireMobileFsResolver(moduleName)(pathStr, mode);
			if (mode === "write") guardMobileFsWritePath(resolved, pathStr);
			a[0] = resolved;
		}
		return (fn as T).apply(this, a as Parameters<T>) as ReturnType<T>;
	} as T;
}

export function wrapMobileFsOpen<T extends AnyFn>(
	moduleName: string,
	fn: T | undefined,
): T {
	return function wrappedMobileFsOpen(
		this: unknown,
		...args: Parameters<T>
	): ReturnType<T> {
		const a: unknown[] = args;
		const pathStr = mobileFsPathLikeToString(a[0], moduleName);
		if (pathStr !== null) {
			const mode = modeForMobileFsOpenFlags(a[1]);
			const resolved = requireMobileFsResolver(moduleName)(pathStr, mode);
			if (mode === "write") guardMobileFsWritePath(resolved, pathStr);
			a[0] = resolved;
		}
		return (fn as T).apply(this, a as Parameters<T>) as ReturnType<T>;
	} as T;
}

export function wrapMobileFsTwoPaths<T extends AnyFn>(
	moduleName: string,
	fn: T | undefined,
	srcMode: FsAccessMode,
	dstMode: FsAccessMode,
): T {
	return function wrappedMobileFsTwoPaths(
		this: unknown,
		...args: Parameters<T>
	): ReturnType<T> {
		const a: unknown[] = args;
		const src = mobileFsPathLikeToString(a[0], moduleName);
		const dst = mobileFsPathLikeToString(a[1], moduleName);
		const resolver = requireMobileFsResolver(moduleName);
		if (src !== null) {
			const resolved = resolver(src, srcMode);
			if (srcMode === "write") guardMobileFsWritePath(resolved, src);
			a[0] = resolved;
		}
		if (dst !== null) {
			const resolved = resolver(dst, dstMode);
			if (dstMode === "write") guardMobileFsWritePath(resolved, dst);
			a[1] = resolved;
		}
		return (fn as T).apply(this, a as Parameters<T>) as ReturnType<T>;
	} as T;
}
