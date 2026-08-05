/**
 * Scans a bundle manifest for ASR lineage/provenance fields that reveal Qwen
 * heritage, returning human-readable blocker strings. Eliza-1 is a Gemma-4
 * release; the strict-release gate rejects any default-eligible bundle whose
 * ASR base or source models still carry Qwen provenance (a pre-cutover
 * stand-in). Paired with `text-provenance.ts`, which reads the same guarantee
 * out of the GGUF header bytes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { claimsStrictRelease } from "./manifest/release-policy";

export const QWEN_PROVENANCE_RE = /\bqwen/i;

function readStringPath(
	input: unknown,
	keys: readonly string[],
): string | undefined {
	let current: unknown = input;
	for (const key of keys) {
		if (!current || typeof current !== "object") return undefined;
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "string" ? current : undefined;
}

export function collectQwenAsrProvenanceBlockers(input: unknown): string[] {
	const blockers: string[] = [];
	const asrBase = readStringPath(input, ["lineage", "asr", "base"]);
	if (asrBase && QWEN_PROVENANCE_RE.test(asrBase)) {
		blockers.push(
			`lineage.asr.base: a strict/defaultEligible Gemma-4 release must not ship Qwen ASR provenance (${asrBase})`,
		);
	}
	const asrRepo = readStringPath(input, [
		"provenance",
		"sourceModels",
		"asr",
		"repo",
	]);
	if (asrRepo && QWEN_PROVENANCE_RE.test(asrRepo)) {
		blockers.push(
			`provenance.sourceModels.asr.repo: a strict/defaultEligible Gemma-4 release must not source ASR from Qwen (${asrRepo})`,
		);
	}
	return blockers;
}

export function readBundleAsrProvenanceBlockers(bundleRoot: string): string[] {
	const manifestPath = path.join(bundleRoot, "eliza-1.manifest.json");
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
	} catch {
		return [];
	}
	if (!claimsStrictRelease(parsed, { allowVersionStaging: true })) return [];
	return collectQwenAsrProvenanceBlockers(parsed);
}

export function bundleHasAsrModelFiles(bundleRoot: string): boolean {
	const asrDir = path.join(bundleRoot, "asr");
	if (!existsSync(asrDir)) return false;
	try {
		let hasTextModel = false;
		let hasProjector = false;
		for (const entry of readdirSync(asrDir, { withFileTypes: true })) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".gguf")) {
				continue;
			}
			if (/mmproj|proj/i.test(entry.name)) {
				hasProjector = true;
			} else {
				hasTextModel = true;
			}
		}
		return hasTextModel && hasProjector;
	} catch {
		return false;
	}
}
