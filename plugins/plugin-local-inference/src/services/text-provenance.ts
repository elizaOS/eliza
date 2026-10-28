/**
 * Reads the `general.architecture` value out of a text GGUF's header bytes to
 * confirm a bundle actually ships a Gemma-4 text model, not a pre-cutover Qwen
 * stand-in. The GGUF header is authoritative where the operator-authored
 * manifest `lineage.text` can drift; this is the byte-level half of the
 * strict-release gate whose manifest half is `asr-provenance.ts`.
 */
import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { QWEN_PROVENANCE_RE } from "./asr-provenance";

// "GGUF" little-endian. The header is the source of truth for a model's
// architecture: a Qwen text GGUF reports `general.architecture = "qwen35"` (or
// "qwen3"), a Gemma-4 text GGUF reports `"gemma4"`. The manifest `lineage.text`
// string is operator-authored and can drift from the bytes actually shipped, so
// the strict-release gate reads the architecture out of the GGUF itself.
const GGUF_MAGIC = 0x4655_4747;

// Eliza-1 is a Gemma-4 family release. Any text GGUF whose architecture does not
// start with `gemma` is a stand-in (the pre-cutover bundles shipped Qwen3.5).
const GEMMA_TEXT_ARCHITECTURE_RE = /^gemma/i;

const MAX_GGUF_HEADER_BYTES = 1 << 20; // 1 MiB — `general.architecture` is one of the first KV entries.

// GGUF metadata value-type tags (gguf spec v2/v3).
enum GgufType {
	Uint8 = 0,
	Int8 = 1,
	Uint16 = 2,
	Int16 = 3,
	Uint32 = 4,
	Int32 = 5,
	Float32 = 6,
	Bool = 7,
	String = 8,
	Array = 9,
	Uint64 = 10,
	Int64 = 11,
	Float64 = 12,
}

const SCALAR_BYTE_WIDTH: Partial<Record<GgufType, number>> = {
	[GgufType.Uint8]: 1,
	[GgufType.Int8]: 1,
	[GgufType.Uint16]: 2,
	[GgufType.Int16]: 2,
	[GgufType.Uint32]: 4,
	[GgufType.Int32]: 4,
	[GgufType.Float32]: 4,
	[GgufType.Bool]: 1,
	[GgufType.Uint64]: 8,
	[GgufType.Int64]: 8,
	[GgufType.Float64]: 8,
};

/**
 * Minimal forward-only GGUF header cursor. Every read is bounds-checked against
 * the buffer; an overrun throws so the public reader can fail closed (return
 * null) rather than mis-parse a truncated header.
 */
class GgufCursor {
	private offset = 0;
	constructor(private readonly buf: Buffer) {}

	private ensure(n: number): void {
		if (this.offset + n > this.buf.length) {
			throw new RangeError("gguf header truncated");
		}
	}

	u32(): number {
		this.ensure(4);
		const v = this.buf.readUInt32LE(this.offset);
		this.offset += 4;
		return v;
	}

	/** GGUF lengths/counts are u64; header-scale values fit in a JS number. */
	u64(): number {
		this.ensure(8);
		const v = this.buf.readBigUInt64LE(this.offset);
		this.offset += 8;
		if (v > BigInt(Number.MAX_SAFE_INTEGER)) {
			throw new RangeError("gguf u64 exceeds safe integer range");
		}
		return Number(v);
	}

	string(): string {
		const len = this.u64();
		this.ensure(len);
		const s = this.buf.toString("utf8", this.offset, this.offset + len);
		this.offset += len;
		return s;
	}

	skip(n: number): void {
		this.ensure(n);
		this.offset += n;
	}

	/** Advance past one metadata value of the given type without decoding it. */
	skipValue(type: GgufType): void {
		const width = SCALAR_BYTE_WIDTH[type];
		if (width !== undefined) {
			this.skip(width);
			return;
		}
		if (type === GgufType.String) {
			this.skip(this.u64());
			return;
		}
		if (type === GgufType.Array) {
			const elemType = this.u32() as GgufType;
			const count = this.u64();
			const elemWidth = SCALAR_BYTE_WIDTH[elemType];
			if (elemWidth !== undefined) {
				this.skip(elemWidth * count);
				return;
			}
			for (let i = 0; i < count; i += 1) this.skipValue(elemType);
			return;
		}
		throw new RangeError(`unsupported gguf value type ${type}`);
	}
}

/**
 * Outcome of reading a GGUF header. `absent` means there is nothing to verify
 * (no file, or a readable GGUF that does not name an architecture). `unreadable`
 * means bytes that exist but could not be turned into an architecture: the
 * shipped model cannot be verified, which is not the same as absent.
 */
type GgufArchitectureRead =
	| { readonly status: "ok"; readonly architecture: string }
	| { readonly status: "absent" }
	| { readonly status: "unreadable"; readonly reason: string };

function readGgufArchitectureResult(filePath: string): GgufArchitectureRead {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const size = Math.min(statSync(filePath).size, MAX_GGUF_HEADER_BYTES);
		const buf = Buffer.allocUnsafe(size);
		const read = readSync(fd, buf, 0, size, 0);
		const cursor = new GgufCursor(buf.subarray(0, read));
		if (cursor.u32() !== GGUF_MAGIC) {
			return { status: "unreadable", reason: "not a GGUF file" };
		}
		cursor.u32(); // version
		cursor.u64(); // tensor_count
		const kvCount = cursor.u64();
		for (let i = 0; i < kvCount; i += 1) {
			const key = cursor.string();
			const type = cursor.u32() as GgufType;
			if (key === "general.architecture") {
				if (type !== GgufType.String) {
					return {
						status: "unreadable",
						reason: `general.architecture is not a string (type ${type})`,
					};
				}
				return { status: "ok", architecture: cursor.string() };
			}
			cursor.skipValue(type);
		}
		return { status: "absent" };
	} catch (error) {
		// A file that is not there makes no claim; anything else (EACCES, EIO,
		// ELOOP, a truncated header, an unknown value type) means the gate could
		// not read the bytes that are shipped.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { status: "absent" };
		}
		return {
			status: "unreadable",
			reason: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * Read `general.architecture` from a GGUF file header. Returns the architecture
 * string (e.g. `"gemma4"`, `"qwen35"`) or `null` when the file is missing,
 * unreadable, not a GGUF, or the key is absent. The reader fails closed (null)
 * so it can never *manufacture* a blocker from a parse failure.
 */
export function readGgufArchitecture(filePath: string): string | null {
	const read = readGgufArchitectureResult(filePath);
	return read.status === "ok" ? read.architecture : null;
}

function architectureBlockers(rel: string, arch: string): string[] {
	if (GEMMA_TEXT_ARCHITECTURE_RE.test(arch)) return [];
	if (QWEN_PROVENANCE_RE.test(arch)) {
		return [
			`files.text (${rel}): a strict/defaultEligible Eliza-1 release must ship the Gemma-4 text model, not a Qwen stand-in (general.architecture=${arch})`,
		];
	}
	return [
		`files.text (${rel}): a strict/defaultEligible Eliza-1 release must ship a Gemma-4 text model (general.architecture=${arch}, expected gemma*)`,
	];
}

/**
 * Blocker if a text GGUF's on-disk architecture is not Gemma-4. Eliza-1 is a
 * Gemma-4 release; a Qwen (or any non-Gemma) text model shipped under the
 * eliza-1 name is rejected so it can never become the default. An unreadable
 * architecture is *not* a blocker (the reader fails closed) — pair this with the
 * existing `files.text` presence checks if a GGUF is required.
 */
export function collectTextArchitectureBlockers(
	textGgufPath: string,
): string[] {
	const read = readGgufArchitectureResult(textGgufPath);
	if (read.status !== "ok") return [];
	return architectureBlockers(path.basename(textGgufPath), read.architecture);
}

interface TextGgufListing {
	readonly ggufs: string[];
	/** Set when `text/` exists but could not be enumerated at all. */
	readonly unreadableDir?: { dir: string; code: string };
}

function bundleTextGgufs(bundleRoot: string): TextGgufListing {
	const textDir = path.join(bundleRoot, "text");
	try {
		return {
			ggufs: readdirSync(textDir)
				.filter((name) => name.toLowerCase().endsWith(".gguf"))
				.map((name) => path.join(textDir, name)),
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// No `text/` directory (`text` may even be a file) means the bundle
		// ships no text GGUF: a legitimate non-claim, not a read failure.
		if (code === "ENOENT" || code === "ENOTDIR") return { ggufs: [] };
		// Anything else (EACCES, EIO, ELOOP, EMFILE) means the gate could not
		// look at the shipped bytes at all, which must not read as "nothing
		// to check".
		return {
			ggufs: [],
			unreadableDir: { dir: textDir, code: code ?? "unknown" },
		};
	}
}

/**
 * Read every text GGUF staged under `<bundleRoot>/text/` and block any whose
 * architecture is not Gemma-4. The companion to `readBundleAsrProvenanceBlockers`
 * for the text model: the manifest's `lineage.text.base` is operator-authored,
 * this verifies the bytes that actually ship.
 *
 * A bundle without a `text/` directory makes no text-model claim and yields no
 * blockers. A `text/` directory that exists but cannot be listed yields one
 * blocker: the shipped text model is unverifiable, which is not the same as
 * absent, and must not let a strict release through. For the same reason a
 * staged `.gguf` whose header cannot be read yields one blocker rather than
 * being skipped.
 */
export function readBundleTextArchitectureBlockers(
	bundleRoot: string,
): string[] {
	const { ggufs, unreadableDir } = bundleTextGgufs(bundleRoot);
	if (unreadableDir) {
		return [
			`files.text: could not list ${unreadableDir.dir} (${unreadableDir.code}); the shipped text model cannot be verified, so this bundle is not a strict/defaultEligible Eliza-1 release`,
		];
	}
	const blockers: string[] = [];
	for (const ggufPath of ggufs) {
		const read = readGgufArchitectureResult(ggufPath);
		if (read.status === "unreadable") {
			// The file is shipped but its architecture cannot be read: like an
			// unlistable `text/`, "I could not look" is not "nothing to check".
			blockers.push(
				`files.text (${path.basename(ggufPath)}): could not read the GGUF header (${read.reason}); the shipped text model cannot be verified, so this bundle is not a strict/defaultEligible Eliza-1 release`,
			);
			continue;
		}
		if (read.status === "ok") {
			blockers.push(
				...architectureBlockers(path.basename(ggufPath), read.architecture),
			);
		}
	}
	return blockers;
}
