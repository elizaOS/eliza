/**
 * `bun:ffi.dlopen()` gate for store-distributed builds.
 *
 * Mac App Store distribution requires the hardened-runtime entitlement
 * `com.apple.security.cs.disable-library-validation` to be **false**: every
 * Mach-O the process loads must be signed by Apple or by the same Team ID
 * that signed the app. The OS enforces this at `dlopen()` time, so any code
 * path that calls into `bun:ffi`'s `dlopen()` with a non-bundle-local path
 * fails at runtime in store builds (and is a sandbox-escape vector in worst
 * cases).
 *
 * This module is the runtime-side counterpart to that entitlement. Every
 * call site that touches `bun:ffi.dlopen()` (or a wrapper around it) MUST
 * call {@link assertDlopenPathAllowed} immediately before the load. The
 * gate is a **hard assertion** in store builds — it throws — and a no-op
 * in direct builds where the user owns the install and we trust the
 * filesystem.
 *
 * What "bundle-local" means on macOS: the resolved absolute library path
 * must live under `<...>/<Name>.app/Contents/` (covers
 * `Contents/MacOS`, `Contents/Resources`, `Contents/Frameworks`, and any
 * other bundle sub-directory).
 *
 * Out of scope:
 * - `node-llama-cpp`, `onnxruntime-node`, etc. — these load native modules
 *   through Node's `process.dlopen` / `require()`-driven `.node` loader,
 *   not through `bun:ffi`. They are governed separately by the Node
 *   loader's own search path and by signing on the bundled `.node`
 *   artifacts.
 * - Non-darwin platforms — only macOS App Sandbox imposes the
 *   library-validation rule. Linux/Windows store variants will get their
 *   own enforcement when those distribution targets land.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { isStoreBuild } from "../build-variant.ts";

/**
 * Cached bundle root once we've resolved it from `process.execPath`.
 * `undefined` = not yet resolved (next call probes execPath).
 * `null` = probed and no `.app` bundle context exists (dev run, source
 * checkout, plain `bun` invocation).
 * `string` = resolved `<...>/<Name>.app/Contents` path.
 */
let cachedBundleRoot: string | null | undefined;

/**
 * Walk up from a Mach-O executable path to its enclosing `.app/Contents`
 * directory. Returns `null` if `execPath` is not inside an `.app` bundle
 * (typical when running from a `bun` install, `node_modules`, or a
 * source checkout).
 */
function resolveBundleContentsRoot(execPath: string): string | null {
	if (!execPath) return null;
	let current = resolve(execPath);
	let parent = dirname(current);
	while (parent !== current) {
		if (current.endsWith(".app") || current.endsWith(`.app${sep}`)) {
			const contents = resolve(current, "Contents");
			return existsSync(contents) ? contents : null;
		}
		current = parent;
		parent = dirname(current);
	}
	return null;
}

/**
 * Resolve and memoize the bundle root for this process. The bundle root is
 * the `Contents/` directory of the enclosing `.app` — every legitimate
 * dlopen target must resolve under it.
 *
 * Returns `null` when the process is not running from an `.app` bundle.
 * Callers treat `null` as "no enforcement applies" so dev/source-tree
 * runs are not broken by the gate.
 */
function getBundleContentsRoot(): string | null {
	if (cachedBundleRoot !== undefined) return cachedBundleRoot;
	if (process.platform !== "darwin") {
		cachedBundleRoot = null;
		return null;
	}
	cachedBundleRoot = resolveBundleContentsRoot(process.execPath);
	return cachedBundleRoot;
}

/**
 * True when `libraryPath` resolves to an absolute path inside the running
 * app bundle's `Contents/` tree. Returns false for:
 * - relative paths (PATH-resolved or unanchored loads),
 * - paths that resolve outside the bundle (including `..` escapes),
 * - any path when the process is not running from an `.app` bundle.
 *
 * Pure function: no side effects, suitable for callers that just want to
 * probe a path. Most production callers should use
 * {@link assertDlopenPathAllowed} instead, which encodes the store-build
 * vs direct-build policy.
 */
export function isPathInsideAppBundle(libraryPath: string): boolean {
	if (typeof libraryPath !== "string" || libraryPath.length === 0) {
		return false;
	}
	if (!isAbsolute(libraryPath)) return false;
	const normalized = resolve(libraryPath);
	const bundleRoot = getBundleContentsRoot();
	if (bundleRoot === null) return false;
	const prefix = bundleRoot.endsWith(sep) ? bundleRoot : bundleRoot + sep;
	return normalized === bundleRoot || normalized.startsWith(prefix);
}

/**
 * Hard assertion gate for `bun:ffi.dlopen()` calls.
 *
 * - **Direct build (any platform):** no-op. The user owns the install; we
 *   trust the filesystem and the library's own signing/integrity story.
 * - **Store build on non-darwin:** no-op for this iteration. macOS App
 *   Sandbox is the only platform whose library-validation policy this
 *   module enforces today. Linux/Windows store variants will get their
 *   own enforcement when those distribution targets land.
 * - **Store build on darwin, no resolvable bundle:** no-op. Treated as a
 *   dev/source-tree run; the gate does not break unbundled execution.
 * - **Store build on darwin, bundle resolved:** throws unless
 *   `libraryPath` is an absolute path inside the running `.app` bundle.
 *
 * @throws {Error} when called in a store build on darwin with a resolvable
 *   bundle and a non-bundle-local path.
 */
export function assertDlopenPathAllowed(libraryPath: string): void {
	if (!isStoreBuild()) return;
	if (process.platform !== "darwin") return;
	const bundleRoot = getBundleContentsRoot();
	if (bundleRoot === null) return;
	if (typeof libraryPath !== "string" || libraryPath.length === 0) {
		throw new Error(
			"Refusing to dlopen empty path in store build (expected absolute bundle-local path)",
		);
	}
	if (!isAbsolute(libraryPath)) {
		throw new Error(
			`Refusing to dlopen relative path in store build: ${libraryPath}`,
		);
	}
	const normalized = resolve(libraryPath);
	const prefix = bundleRoot.endsWith(sep) ? bundleRoot : bundleRoot + sep;
	if (normalized !== bundleRoot && !normalized.startsWith(prefix)) {
		throw new Error(
			`Refusing to dlopen outside app bundle in store build: ${libraryPath} (bundle=${bundleRoot})`,
		);
	}
}

/**
 * Test hook. Override the resolved bundle root so tests can simulate a
 * store-build environment without controlling `process.execPath`.
 *
 * Pass `null` to clear the override (next call resolves from `execPath`
 * again — which typically yields `null` in CI/dev). Pass an absolute path
 * to pin the bundle root to that value (must point at the `Contents/`
 * directory).
 */
export function _setAppBundleRootForTests(root: string | null): void {
	cachedBundleRoot = root === null ? undefined : root;
}
