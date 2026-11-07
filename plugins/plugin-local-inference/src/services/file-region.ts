/**
 * libelizainference region files (fork `tools/file-region/eliza-file-region.h`).
 *
 * A region file stands in for a model stored inside another file, such as an
 * uncompressed asset in an Android APK (`VoiceBundleAssets` with
 * `ai.eliza.voice.MODELS_IN_PLACE`). It is a small text file:
 *
 *   eliza-file-region v1
 *   offset=<first byte of the model in the containing file>
 *   length=<model size in bytes>
 *   path=<absolute path of the containing file>
 *
 * The native loaders read the model from those bytes. TypeScript readers of
 * bundle model headers resolve the path the same way, so a region bundle reads
 * as the model it names. The rules match the C++ header.
 */
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export const FILE_REGION_MAGIC = "eliza-file-region v1";
/** A region file is a few hundred bytes; anything larger is a model. */
const MAX_REGION_FILE = 4096;
const REGION_ALIGNMENT = 16n;

export interface FileRegion {
	/** File that holds the bytes. */
	path: string;
	/** First byte in `path`. */
	offset: number;
	/** Bytes. */
	length: number;
	/** True when resolved from a region file. */
	indirect: boolean;
}

function parseCount(text: string): bigint | null {
	if (!/^[0-9]{1,20}$/.test(text)) return null;
	const value = BigInt(text);
	return value <= 0xffffffffffffffffn ? value : null;
}

/** Parses region-file text; throws when it is not a valid region file. */
export function parseFileRegion(text: string): Omit<FileRegion, "indirect"> {
	const lines = text.split("\n");
	if (text.endsWith("\n")) lines.pop();
	if (lines[0] !== FILE_REGION_MAGIC) throw new Error("not a region file");
	let offset: bigint | null | undefined;
	let length: bigint | null | undefined;
	let containing: string | undefined;
	for (const line of lines.slice(1)) {
		if (line === "") continue;
		const eq = line.indexOf("=");
		const key = eq < 0 ? line : line.slice(0, eq);
		const value = eq < 0 ? "" : line.slice(eq + 1);
		let ok = eq >= 0;
		if (key === "offset" && offset === undefined) {
			offset = parseCount(value);
			ok &&= offset !== null;
		} else if (key === "length" && length === undefined) {
			length = parseCount(value);
			ok &&= length !== null;
		} else if (key === "path" && containing === undefined) {
			containing = value;
			ok &&= value.startsWith("/");
		} else {
			ok = false;
		}
		if (!ok) throw new Error(`invalid region file line '${line}'`);
	}
	if (
		offset == null ||
		length == null ||
		containing === undefined ||
		length === 0n
	)
		throw new Error("region file needs offset, length and an absolute path");
	if (offset % REGION_ALIGNMENT !== 0n)
		throw new Error(
			`region offset ${offset} is not a multiple of ${REGION_ALIGNMENT}`,
		);
	if (offset + length > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("region is too large");
	return { path: containing, offset: Number(offset), length: Number(length) };
}

/**
 * Resolves a model path. A region file gives its region of the containing
 * file, checked against that file's size; any other file gives the whole
 * file. A missing `file` throws the filesystem error itself (`ENOENT`); an
 * invalid region file, or one whose containing file is missing or too short,
 * throws an error without a code.
 */
export function resolveFileRegion(file: string): FileRegion {
	const fd = openSync(file, "r");
	let size: number;
	let head = "";
	try {
		size = fstatSync(fd).size;
		if (size > 0 && size <= MAX_REGION_FILE) {
			const buf = Buffer.alloc(size);
			const got = readSync(fd, buf, 0, size, 0);
			head = buf.toString("latin1", 0, got);
		}
	} finally {
		closeSync(fd);
	}
	if (
		head.length > FILE_REGION_MAGIC.length &&
		head.startsWith(FILE_REGION_MAGIC) &&
		head[FILE_REGION_MAGIC.length] === "\n"
	) {
		let region: Omit<FileRegion, "indirect">;
		try {
			region = parseFileRegion(Buffer.from(head, "latin1").toString("utf8"));
		} catch (error) {
			throw new Error(`'${file}': ${(error as Error).message}`);
		}
		let outer: ReturnType<typeof statSync>;
		try {
			outer = statSync(region.path);
		} catch (error) {
			// A missing containing file is a broken region, not a missing model.
			throw new Error(`'${file}': cannot open '${region.path}'`, {
				cause: error,
			});
		}
		if (!outer.isFile())
			throw new Error(`'${file}': '${region.path}' is not a file`);
		if (
			region.offset > outer.size ||
			region.length > outer.size - region.offset
		)
			throw new Error(
				`'${file}': region runs past the end of '${region.path}'`,
			);
		return { ...region, indirect: true };
	}
	return { path: file, offset: 0, length: size, indirect: false };
}

/** Reads up to `bytes` from the start of a resolved region. */
export function readFileRegionHead(region: FileRegion, bytes: number): Buffer {
	const want = Math.min(bytes, region.length);
	const buf = Buffer.alloc(want);
	const fd = openSync(region.path, "r");
	try {
		let got = 0;
		while (got < want) {
			const n = readSync(fd, buf, got, want - got, region.offset + got);
			if (n === 0) break;
			got += n;
		}
		return buf.subarray(0, got);
	} finally {
		closeSync(fd);
	}
}
