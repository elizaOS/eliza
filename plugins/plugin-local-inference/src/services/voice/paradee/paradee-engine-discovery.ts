/**
 * On-disk discovery for the desktop Paradee-8M v1.1 TTS path.
 *
 * Desktop product TTS runs through the explicit host worker
 * (`src/host-tts-worker.ts`) on libelizainference, the same Paradee head the
 * Android and AOSP builds ship. The worker hashes the library against a
 * reviewed digest and every model file against its pin before any native code
 * loads, so discovery only decides whether the worker can be started: it never
 * hashes, downloads or converts anything.
 *
 * Model directory, first hit wins:
 *   1. `ELIZA_PARADEE_MODEL_DIR` (absolute),
 *   2. `<bundleRoot>/tts/paradee/` of the active Eliza-1 bundle,
 *   3. `<stateDir>/local-inference/models/paradee/`.
 * A directory qualifies when it holds `paradee-8m-v1_1.gguf` and
 * `misaki-en-us.lex` at their pinned sizes.
 *
 * Library: `resolveFusedLibraryPath` (ELIZA_INFERENCE_LIBRARY, bundle `lib/`,
 * ELIZA_INFERENCE_LIB_DIR, `<stateDir>/local-inference/lib`). Its reviewed
 * digest is `ELIZA_INFERENCE_LIBRARY_SHA256` when that names the same library,
 * else the `fusedSha256` that `stage-desktop-fused-lib.ts` records in the
 * `.eliza-fused-build-stamp.json` next to the library. Without a digest the
 * worker would refuse the library, so Paradee is reported unavailable.
 */

import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import { resolveFusedLibraryPath } from "../../desktop-fused-ffi-backend-runtime";

/** Pinned Paradee files; must match `PARADEE_ASSETS` in `host-tts-worker.ts`. */
export const PARADEE_MODEL_FILES = [
	{ path: "paradee-8m-v1_1.gguf", bytes: 31_275_232 },
	{ path: "misaki-en-us.lex", bytes: 12_947_790 },
] as const;

/** Paradee-8M v1.1 output sample rate. */
export const PARADEE_SAMPLE_RATE = 24_000;

/** Voice id the scheduler preset carries; Paradee ships one voice. */
export const PARADEE_VOICE_ID = "paradee";

/** Written by `packages/app/scripts/stage-desktop-fused-lib.ts`. */
const FUSED_BUILD_STAMP = ".eliza-fused-build-stamp.json";

export interface ParadeeEngineConfig {
	/** Absolute directory holding the pinned Paradee GGUF and lexicon. */
	modelDir: string;
	/** Absolute path to the fused libelizainference the worker loads. */
	library: string;
	/** Reviewed sha256 of `library`; the worker refuses any other bytes. */
	librarySha256: string;
}

export type ParadeeDiscovery =
	| { ok: true; config: ParadeeEngineConfig }
	| { ok: false; reason: string };

function checkPinnedModelFiles(dir: string): {
	staged: boolean;
	unreadable?: string;
} {
	for (const file of PARADEE_MODEL_FILES) {
		const filePath = path.join(dir, file.path);
		try {
			const stat = lstatSync(filePath);
			if (!stat.isFile() || stat.size !== file.bytes) return { staged: false };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// ENOENT/ENOTDIR: this candidate does not hold the pinned file.
			// Anything else (EACCES, EIO, EMFILE) means the directory could
			// not be looked at, which is not the same as "not staged".
			if (code === "ENOENT" || code === "ENOTDIR") return { staged: false };
			return {
				staged: false,
				unreadable: `${filePath} (${code ?? "unreadable"})`,
			};
		}
	}
	return { staged: true };
}

/** Candidate model directories in precedence order. */
export function paradeeModelDirCandidates(
	bundleRoot?: string | null,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const dirs: string[] = [];
	const explicit = env.ELIZA_PARADEE_MODEL_DIR?.trim();
	if (explicit && path.isAbsolute(explicit)) dirs.push(explicit);
	if (bundleRoot) dirs.push(path.join(bundleRoot, "tts", "paradee"));
	dirs.push(
		path.join(resolveStateDir(env), "local-inference", "models", "paradee"),
	);
	return dirs;
}

function reviewedLibraryDigest(
	library: string,
	env: NodeJS.ProcessEnv,
): string | null {
	const explicit = env.ELIZA_INFERENCE_LIBRARY?.trim();
	const digest = env.ELIZA_INFERENCE_LIBRARY_SHA256?.trim().toLowerCase();
	if (
		explicit &&
		path.resolve(explicit) === path.resolve(library) &&
		digest &&
		/^[a-f0-9]{64}$/.test(digest)
	) {
		return digest;
	}
	const stampPath = path.join(path.dirname(library), FUSED_BUILD_STAMP);
	if (!existsSync(stampPath)) return null;
	try {
		const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as {
			fusedLib?: unknown;
			fusedSha256?: unknown;
		};
		if (
			stamp.fusedLib === path.basename(library) &&
			typeof stamp.fusedSha256 === "string" &&
			/^[a-f0-9]{64}$/.test(stamp.fusedSha256)
		) {
			return stamp.fusedSha256;
		}
	} catch {
		return null;
	}
	return null;
}

/**
 * Resolve everything the host TTS worker needs, or the reason it cannot run.
 * Cheap: stats files and reads the small build stamp; never hashes.
 */
export function discoverParadeeEngine(
	opts: { bundleRoot?: string | null; env?: NodeJS.ProcessEnv } = {},
): ParadeeDiscovery {
	const env = opts.env ?? process.env;
	let modelDir: string | undefined;
	let unreadable: string | undefined;
	for (const dir of paradeeModelDirCandidates(opts.bundleRoot, env)) {
		const check = checkPinnedModelFiles(dir);
		if (check.staged) {
			modelDir = dir;
			break;
		}
		unreadable ??= check.unreadable;
	}
	if (!modelDir) {
		if (unreadable) {
			// The first candidate that could not be looked at decides the
			// message: reporting a read failure as "not staged" sends the
			// operator to download a model that may be staged and readable
			// only after a permission fix.
			return {
				ok: false,
				reason: `Paradee-8M v1.1 could not be read at ${unreadable}; this is a read failure, not a missing install`,
			};
		}
		return {
			ok: false,
			reason: `Paradee-8M v1.1 is not staged (looked for ${PARADEE_MODEL_FILES.map((f) => f.path).join(" + ")} in ELIZA_PARADEE_MODEL_DIR, <bundle>/tts/paradee and <stateDir>/local-inference/models/paradee)`,
		};
	}
	const library = resolveFusedLibraryPath(opts.bundleRoot ?? null, env);
	if (!library) {
		return {
			ok: false,
			reason:
				"the fused libelizainference is not staged (set ELIZA_INFERENCE_LIBRARY or run packages/app/scripts/stage-desktop-fused-lib.ts)",
		};
	}
	const librarySha256 = reviewedLibraryDigest(library, env);
	if (!librarySha256) {
		return {
			ok: false,
			reason: `no reviewed digest for ${library} (set ELIZA_INFERENCE_LIBRARY_SHA256, or stage it with stage-desktop-fused-lib.ts, which records one)`,
		};
	}
	return {
		ok: true,
		config: { modelDir: path.resolve(modelDir), library, librarySha256 },
	};
}

/** The resolved config, or null when Paradee cannot run on this host. */
export function resolveParadeeEngineConfig(
	opts: { bundleRoot?: string | null; env?: NodeJS.ProcessEnv } = {},
): ParadeeEngineConfig | null {
	const found = discoverParadeeEngine(opts);
	return found.ok ? found.config : null;
}
