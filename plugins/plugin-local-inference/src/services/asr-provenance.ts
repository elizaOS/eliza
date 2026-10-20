/**
 * Scans a bundle manifest for ASR lineage/provenance fields that reveal Qwen
 * heritage, returning human-readable blocker strings. Eliza-1 is a Gemma-4
 * release; the strict-release gate rejects any default-eligible bundle whose
 * ASR base or source models still carry Qwen provenance (a pre-cutover
 * stand-in). Paired with `text-provenance.ts`, which reads the same guarantee
 * out of the GGUF header bytes.
 *
 * Scope: this block reads ONLY the Eliza-1 bundle manifest's own ASR lineage
 * (`lineage.asr.base`, `provenance.sourceModels.asr.repo`). The local ASR is
 * Phonon-2 (`asr/phonon-2-fv5.gguf`, Parakeet-TDT, not Qwen): the pinned
 * mobile voice bundle (`mobile-voice` in plugin-native-inference's
 * voice-model-versions.json) stages it into `asr/` with an
 * `asr/voice-files.json` record, and the Eliza-1 manifest says nothing about
 * it. A strict Eliza-1 text bundle can therefore transcribe with Phonon-2.
 */
import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
} from "node:fs";
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
	} catch (error) {
		// A bundle without an Eliza-1 manifest is legitimately non-strict.
		// A manifest that exists but cannot be read or parsed is not "no
		// provenance": surface it instead of claiming there are no blockers.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new Error(
			`failed to read ASR provenance manifest at ${manifestPath}`,
			{ cause: error },
		);
	}
	if (!claimsStrictRelease(parsed, { allowVersionStaging: true })) return [];
	return collectQwenAsrProvenanceBlockers(parsed);
}

/** GGUF `general.architecture` of the fused library's Parakeet-TDT backend. */
export const PARAKEET_TDT_ARCHITECTURE = "parakeet-tdt";

const GGUF_SCALAR_BYTES: Readonly<Record<number, number>> = {
	0: 1,
	1: 1,
	2: 2,
	3: 2,
	4: 4,
	5: 4,
	6: 4,
	7: 1,
	10: 8,
	11: 8,
	12: 8,
};

/** True for the fs codes that mean "there is nothing there", not "read failed". */
function isAbsentError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Read `general.architecture` from a GGUF header, or null when the file is
 * not a GGUF or the key is not among the leading scalar/string entries
 * (converters write it first). Reads at most the first 64 KiB.
 *
 * A file that cannot be read (EACCES/EIO/EMFILE) throws instead of returning
 * null: callers gate local ASR on this value, so "I could not read the bytes"
 * must not be reported as "this is not an ASR model".
 */
export function readGgufArchitecture(file: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(file, "r");
		const head = Buffer.alloc(64 * 1024);
		const length = readSync(fd, head, 0, head.length, 0);
		const buf = head.subarray(0, length);
		if (buf.length < 24 || buf.toString("ascii", 0, 4) !== "GGUF") return null;
		const kvCount = buf.readBigUInt64LE(16);
		let offset = 24;
		const readString = (): string | null => {
			if (offset + 8 > buf.length) return null;
			const size = Number(buf.readBigUInt64LE(offset));
			offset += 8;
			if (size > buf.length - offset) return null;
			const value = buf.toString("utf8", offset, offset + size);
			offset += size;
			return value;
		};
		for (let i = 0n; i < kvCount; i++) {
			const key = readString();
			if (key === null || offset + 4 > buf.length) return null;
			const type = buf.readUInt32LE(offset);
			offset += 4;
			if (type === 8) {
				const value = readString();
				if (value === null) return null;
				if (key === "general.architecture") return value;
			} else if (type in GGUF_SCALAR_BYTES) {
				offset += GGUF_SCALAR_BYTES[type] as number;
			} else {
				// An array before the architecture key: stop rather than walk it.
				return null;
			}
		}
		return null;
	} catch (error) {
		// A missing file is "not a parakeet GGUF": the model was never staged
		// (or was removed between `readdirSync` and `openSync`). Any other
		// failure means the staged bytes could not be inspected at all, so it
		// must surface rather than read as "no ASR model here".
		if (isAbsentError(error)) return null;
		throw new Error(`failed to read GGUF header at ${file}`, { cause: error });
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * True when `<bundle>/asr/` holds a model the fused library can load: a
 * Parakeet-TDT GGUF (Phonon-2). No other local ASR is supported.
 *
 * A bundle with no `asr/` directory stages no local ASR (false), but an
 * `asr/` directory or GGUF that exists and cannot be read keeps throwing:
 * "could not look" is not "there is nothing to load".
 */
export function bundleHasAsrModelFiles(bundleRoot: string): boolean {
	const asrDir = path.join(bundleRoot, "asr");
	if (!existsSync(asrDir)) return false;
	try {
		return readdirSync(asrDir, { withFileTypes: true }).some(
			(entry) =>
				entry.isFile() &&
				entry.name.toLowerCase().endsWith(".gguf") &&
				readGgufArchitecture(path.join(asrDir, entry.name)) ===
					PARAKEET_TDT_ARCHITECTURE,
		);
	} catch (error) {
		if (isAbsentError(error)) return false;
		throw error;
	}
}
