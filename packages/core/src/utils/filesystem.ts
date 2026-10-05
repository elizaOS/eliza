/**
 * Minimal fs-extra-compatible helpers built on node:fs/promises.
 *
 * fs-extra must not be imported from core: unlike `node:*` (externalized by
 * every bundler config in this repo), fs-extra is bundleable, and its
 * graceful-fs dependency probes `fs.realpath.native` at MODULE INIT — which
 * crashes the Cloudflare edge bundle under workerd's nodejs_compat, where
 * `fs.realpath` is undefined ("Cannot read properties of undefined (reading
 * 'native')"). These helpers keep the ergonomic surface the Node-side feature
 * services use while leaving all filesystem access on the external `node:fs`
 * seam, so importing them is init-safe in every build target.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

export type SymlinkType = "dir" | "file" | "junction";

export async function pathExists(target: string): Promise<boolean> {
	try {
		await fsp.access(target);
		return true;
	} catch {
		return false;
	}
}

// fs-extra's readJson resolves `any`; keep that default so existing callers'
// untyped property access continues to typecheck. New callers should pass T.
// biome-ignore lint/suspicious/noExplicitAny: fs-extra contract compatibility
export async function readJson<T = any>(file: string): Promise<T> {
	const contents = await fsp.readFile(file, "utf8");
	return JSON.parse(contents.replace(/^\uFEFF/, "")) as T;
}

export async function writeJson(
	file: string,
	value: unknown,
	options?: { spaces?: number },
): Promise<void> {
	// fs-extra (via jsonfile) always terminates the document with a newline.
	const serialized = JSON.stringify(value, null, options?.spaces);
	if (serialized === undefined) {
		throw new TypeError(
			`Converting ${typeof value} value to JSON is not supported`,
		);
	}
	await fsp.writeFile(file, `${serialized}\n`);
}

export async function ensureDir(dir: string): Promise<void> {
	await fsp.mkdir(dir, { recursive: true });
}

export async function remove(target: string): Promise<void> {
	await fsp.rm(target, { recursive: true, force: true });
}

export async function copy(src: string, dest: string): Promise<void> {
	await fsp.cp(src, dest, { recursive: true, force: true });
}

/**
 * Create a symlink, creating the parent directory first. Callers here always
 * `remove()` the destination beforehand, so no fs-extra-style "already points
 * at the right target" reconciliation is needed.
 */
export async function ensureSymlink(
	target: string,
	linkPath: string,
	type?: SymlinkType,
): Promise<void> {
	await fsp.mkdir(path.dirname(linkPath), { recursive: true });
	await fsp.symlink(target, linkPath, type);
}

export const readFile = fsp.readFile.bind(fsp);
export const readdir = fsp.readdir.bind(fsp);
export const stat = fsp.stat.bind(fsp);
export const unlink = fsp.unlink.bind(fsp);
export const rmdir = fsp.rmdir.bind(fsp);
