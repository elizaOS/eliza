/**
 * Static-analysis guard: no live `onnxruntime-node` / `onnxruntime-web` import
 * may exist in the local-inference runtime source (issue #12216, fix C15).
 *
 * The single-runtime policy (native/AGENTS.md §11) is that every model path
 * flows through ONE managed library (`libelizainference`) over ONE FFI pipe.
 * ONNX was the pre-native path for VAD, wake-word, Kokoro, and the three voice
 * classifier heads (Wav2Small emotion, WeSpeaker, pyannote-3); all of those
 * migrated to native FFI/GGUF, and `onnxruntime-*` is not even a dependency.
 *
 * This test walks the whole `src/` tree and fails if any file re-introduces an
 * `import`/`require` from `onnxruntime-node` or `onnxruntime-web` — a regression
 * would silently pull a second, unmanaged inference runtime back into the voice
 * pipeline. The allowlist is intentionally EMPTY: there is no compliant reason
 * for a runtime ONNX import today. If one becomes necessary, add the exact
 * relative path here with a comment explaining why, so the exception is explicit
 * and reviewed rather than drifting in unnoticed.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
// .../src/services/voice -> .../src
const SRC_ROOT = path.resolve(here, "..", "..");

/**
 * Relative-to-SRC_ROOT paths permitted to import an onnxruntime-* package.
 * EMPTY by design — see the file header.
 */
const ALLOWLIST: ReadonlySet<string> = new Set<string>();

const ONNX_IMPORT_RE =
	/(?:import[^;\n]*from\s*|require\(\s*)['"]onnxruntime-(?:node|web)['"]/;

function* walkTsFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			yield* walkTsFiles(full);
			continue;
		}
		if (!entry.isFile()) continue;
		if (!/\.tsx?$/.test(entry.name)) continue;
		// Skip test files: a test may legitimately reference the string to assert
		// against it (this file does).
		if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
		yield full;
	}
}

describe("onnxruntime import ban (C15 / native/AGENTS.md §11)", () => {
	it("has no live onnxruntime-node/web import outside the allowlist", () => {
		const offenders: string[] = [];
		for (const file of walkTsFiles(SRC_ROOT)) {
			const rel = path.relative(SRC_ROOT, file);
			if (ALLOWLIST.has(rel)) continue;
			const source = readFileSync(file, "utf8");
			if (ONNX_IMPORT_RE.test(source)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});
});
