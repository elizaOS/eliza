import * as realFs from "node:fs";
import { fileURLToPath } from "node:url";

export type FsAccessMode = "read" | "write";
export type AnyFn = (...args: unknown[]) => unknown;
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
  return function wrappedMobileFsPath(this: unknown, ...args: unknown[]) {
    const pathStr = mobileFsPathLikeToString(args[0], moduleName);
    if (pathStr !== null) {
      args[0] = requireMobileFsResolver(moduleName)(pathStr, mode);
    }
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}

export function wrapMobileFsOpen<T extends AnyFn>(
  moduleName: string,
  fn: T | undefined,
): T {
  return function wrappedMobileFsOpen(this: unknown, ...args: unknown[]) {
    const pathStr = mobileFsPathLikeToString(args[0], moduleName);
    if (pathStr !== null) {
      args[0] = requireMobileFsResolver(moduleName)(
        pathStr,
        modeForMobileFsOpenFlags(args[1]),
      );
    }
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}

export function wrapMobileFsTwoPaths<T extends AnyFn>(
  moduleName: string,
  fn: T | undefined,
  srcMode: FsAccessMode,
  dstMode: FsAccessMode,
): T {
  return function wrappedMobileFsTwoPaths(this: unknown, ...args: unknown[]) {
    const src = mobileFsPathLikeToString(args[0], moduleName);
    const dst = mobileFsPathLikeToString(args[1], moduleName);
    const resolver = requireMobileFsResolver(moduleName);
    if (src !== null) args[0] = resolver(src, srcMode);
    if (dst !== null) args[1] = resolver(dst, dstMode);
    return (fn as T).apply(this, args as Parameters<T>);
  } as T;
}
