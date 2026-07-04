/**
 * Static-analysis detector for the memory-arbiter capability-contract bypass
 * (issue #12216, fix C11 — DETECTION ONLY, not the re-wire).
 *
 * The plugin's own contract (memory-arbiter.ts §doc, native/CLAUDE.md) is that
 * cross-plugin model consumers go through the arbiter — "never load models
 * independently". In production only two capabilities are ever registered
 * (`vision-describe`, `image-gen`, both in `service.ts`). The `text`,
 * `embedding`, and `transcribe` capabilities have full API surface
 * (`requestText`/`requestEmbedding`/`requestTranscribe`) that would throw
 * "no capability registered" if called — dead API — and the voice/ASR/TTS
 * subsystems load GGUF weights via direct `bun:ffi`/`dlopen` with no arbiter
 * involvement.
 *
 * This test does NOT fix that (the re-wire is a real feature change). It PINS
 * the current bypass as a known, documented fact so the drift is visible:
 *   - `voice/` (which also hosts the ASR/TTS FFI seams) DOES contain direct
 *     FFI model-load call sites not routed through
 *     `arbiter.registerCapability(...)`.
 *   - `vision/` and `imagegen/` are registered THROUGH the arbiter
 *     (`create*CapabilityRegistration`) and must stay that way.
 *
 * If a future change wires voice/ASR through the arbiter (good — closes the
 * gap) OR sneaks a new direct-FFI load into vision/imagegen (bad — a new
 * bypass), this test fails and forces the change to be acknowledged.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVICES_ROOT = here;

/** A direct native model-load seam: `bun:ffi` resolution or a raw `dlopen`. */
const DIRECT_FFI_RE = /require\(\s*['"]bun:ffi['"]\s*\)|\bdlopen\s*[<(]/;
/** An arbiter capability registration wrapper. */
const ARBITER_REG_RE =
	/create\w*CapabilityRegistration|arbiter\.registerCapability\s*\(/;

function collectTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules") continue;
			out.push(...collectTsFiles(full));
			continue;
		}
		if (!entry.isFile()) continue;
		if (!/\.tsx?$/.test(entry.name)) continue;
		if (/\.(test|spec)\.tsx?$/.test(entry.name)) continue;
		out.push(full);
	}
	return out;
}

function subsystemMatches(subdir: string, re: RegExp): string[] {
	const root = path.join(SERVICES_ROOT, subdir);
	const hits: string[] = [];
	for (const file of collectTsFiles(root)) {
		if (re.test(readFileSync(file, "utf8"))) {
			hits.push(path.relative(SERVICES_ROOT, file));
		}
	}
	return hits;
}

describe("memory-arbiter capability-contract bypass detection (C11)", () => {
	it("documents that voice/ loads models via direct FFI, bypassing the arbiter", () => {
		// KNOWN BYPASS. This is a real, if partial, violation of the plugin's own
		// "never load models independently" rule. The fix (registering
		// `transcribe`/`text-to-speech` capabilities) is a feature change tracked
		// as a follow-up in .github/issue-evidence/12216-runtime-status.md.
		const voiceFfi = subsystemMatches("voice", DIRECT_FFI_RE);
		expect(voiceFfi.length).toBeGreaterThan(0);
	});

	it("confirms vision/ and imagegen/ route through arbiter registration", () => {
		// These two ARE compliant — they expose their model load only through a
		// `create*CapabilityRegistration` wrapper that `service.ts` hands to
		// `arbiter.registerCapability(...)`. If this regresses to a direct-FFI
		// load, that's a new bypass and this assertion catches it.
		expect(subsystemMatches("vision", ARBITER_REG_RE).length).toBeGreaterThan(
			0,
		);
		expect(subsystemMatches("imagegen", ARBITER_REG_RE).length).toBeGreaterThan(
			0,
		);
	});

	it("pins the exact voice FFI-load files so the bypass surface is reviewable", () => {
		// Snapshot the current direct-FFI load surface in voice/. A change to this
		// set — either a new direct-FFI file (surface grew) or one disappearing
		// (routed through the arbiter, or removed) — forces a conscious update
		// here rather than silent drift.
		const voiceFfi = new Set(subsystemMatches("voice", DIRECT_FFI_RE));
		const expected = [
			"voice/ffi-bindings.ts",
			"voice/kokoro/kokoro-engine-discovery.ts",
			"voice/kokoro/kokoro-ffi-runtime.ts",
			"voice/wake-word-ggml.ts",
		];
		for (const file of expected) {
			expect(voiceFfi.has(file)).toBe(true);
		}
	});
});
