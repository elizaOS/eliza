/**
 * Host → fused-lib target resolution for bundle delivery (#9105 / local-
 * inference).
 *
 * An Eliza-1 bundle's `files.lib[]` carries the fused `libelizainference` SET
 * (the fused lib + its ggml/llama/mtmd sibling backends) per platform `target`.
 * The downloader fetches ONLY the set matching the host into `<bundleRoot>/lib/`,
 * which the desktop FFI runtime resolves with no env wiring
 * (`desktop-fused-ffi-backend-runtime.ts` `resolveFusedLibraryPath`, path #2).
 *
 * Pure + injectable (platform / arch / env are all overridable) so the mapping
 * is unit-testable on any host.
 */

import type { Eliza1Files, Eliza1LibFileEntry } from "./manifest";

export interface HostLibTargetOptions {
	platform?: NodeJS.Platform;
	arch?: string;
	env?: NodeJS.ProcessEnv;
	/** Prefer a GPU-accelerated target when the bundle hosts one. */
	preferGpu?: boolean;
}

function platformKey(platform: NodeJS.Platform): string {
	if (platform === "win32") return "win";
	return platform; // "linux" | "darwin"
}

/**
 * Ordered list of acceptable `target` keys for the host, best-first. The
 * downloader picks the first target the bundle actually hosts.
 *
 *   - `ELIZA_INFERENCE_LIB_TARGET` pins a single target (power users / CI).
 *   - Mobile (`ELIZA_PLATFORM=android|ios`) returns `[]` — phones ship the lib
 *     natively (jniLibs / xcframework), never via bundle delivery.
 *   - CPU is preferred by default: the fused lib always has GGML_CPU built in,
 *     so the CPU set works on every host and is the smallest download. GPU sets
 *     (`…-cuda`) are opt-in via `preferGpu` or the env pin.
 *   - macOS arm64 maps to the `metal` set, which itself carries the CPU
 *     fallback, so it is the canonical mac target.
 */
export function resolveHostLibTargets(
	opts: HostLibTargetOptions = {},
): string[] {
	const platform = opts.platform ?? process.platform;
	const arch = opts.arch ?? process.arch;
	const env = opts.env ?? process.env;

	const mobile = (env.ELIZA_PLATFORM ?? "").toLowerCase();
	if (mobile === "android" || mobile === "ios") return [];

	const pinned = env.ELIZA_INFERENCE_LIB_TARGET?.trim();
	if (pinned) return [pinned];

	const base = `${platformKey(platform)}-${arch}`;
	const cpu = `${base}-cpu`;
	const cuda = `${base}-cuda`;
	const metal = `${base}-metal`;

	if (platform === "darwin") {
		// The metal set carries a CPU fallback, so it is the mac default.
		return [metal, cpu, base];
	}
	return opts.preferGpu === true ? [cuda, cpu, base] : [cpu, base, cuda];
}

export interface SelectedLibTarget {
	readonly target: string;
	readonly files: ReadonlyArray<Eliza1LibFileEntry>;
}

/**
 * Pick the bundle's lib file set for the first host target the manifest
 * actually carries. Returns null when the bundle has no `lib[]` or hosts no
 * target the host accepts (⇒ the runtime falls back to other resolution paths,
 * ultimately cloud).
 */
export function selectBundleLibFiles(
	manifest: { files: Pick<Eliza1Files, "lib"> },
	targets: ReadonlyArray<string>,
): SelectedLibTarget | null {
	const lib = manifest.files.lib;
	if (!lib || lib.length === 0) return null;
	for (const target of targets) {
		const files = lib.filter((e) => e.target === target);
		if (files.length > 0) return { target, files };
	}
	return null;
}

/**
 * Flat staged filename under `<bundleRoot>/lib/` for a lib entry. Always a
 * basename (any directory component in `name`/`path` is stripped) so a manifest
 * can never write outside the lib dir.
 */
export function libStagedName(entry: Eliza1LibFileEntry): string {
	const raw =
		entry.name && entry.name.trim().length > 0 ? entry.name.trim() : entry.path;
	const parts = raw.split(/[\\/]/);
	return parts[parts.length - 1] || raw;
}
