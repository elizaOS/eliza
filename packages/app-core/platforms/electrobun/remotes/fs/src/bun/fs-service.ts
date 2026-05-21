import {
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	stat,
	writeFile,
} from "node:fs/promises";
import path from "node:path";
import { throwFileRemoteError } from "./errors.ts";
import { loadFileLimits, type FileLimits } from "./file-limits.ts";
import { PathGuard, type GuardedPath } from "./path-guard.ts";
import type {
	FileListParams,
	FileListResult,
	FileReadTextParams,
	FileReadTextResult,
	FileRoot,
	FileSearchMatch,
	FileSearchParams,
	FileSearchResult,
	FileStat,
	FileWriteTextParams,
	FileWriteTextResult,
} from "./protocol.ts";

const BINARY_SAMPLE_BYTES = 4096;

export class FileRemoteService {
	private readonly pathGuard: PathGuard;
	private readonly limits: FileLimits;
	private readonly writesEnabled: boolean;

	constructor(options: { env?: NodeJS.ProcessEnv } = {}) {
		const env = options.env ?? process.env;
		this.pathGuard = new PathGuard(env);
		this.limits = loadFileLimits(env);
		this.writesEnabled = env.ELIZA_FS_ENABLE_WRITES === "1";
	}

	async status(): Promise<unknown> {
		return {
			id: "eliza.fs",
			ok: true,
			roots: await this.roots(),
			limits: this.limits,
			writesEnabled: this.writesEnabled,
		};
	}

	roots(): Promise<FileRoot[]> {
		return this.pathGuard.roots();
	}

	async stat(params: { path: string }): Promise<FileStat> {
		const guarded = await this.resolveRequiredPath(params.path);
		return this.toFileStat(guarded);
	}

	async list(params: FileListParams = {}): Promise<FileListResult> {
		const limit = clampLimit(
			params.limit,
			this.limits.maxDirectoryEntries,
			this.limits.maxDirectoryEntries,
		);
		const ignoreMatchers = (params.ignore ?? [])
			.filter((entry) => entry.length > 0)
			.map((entry) => globToRegExp(entry));
		const guarded = await this.pathGuard.resolvePath({
			path: params.path,
			rootId: params.rootId,
			includeHidden: params.includeHidden === true,
		});
		const stats = await stat(guarded.realPath);
		if (!stats.isDirectory()) {
			throwFileRemoteError({
				code: "FS_NOT_A_DIRECTORY",
				message: "Path is not a directory.",
				path: guarded.absolutePath,
			});
		}

		const entries = await readdir(guarded.realPath, { withFileTypes: true });
		const result: FileStat[] = [];
		let totalAfterIgnore = 0;
		for (const entry of entries.sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			if (ignoreMatchers.some((matcher) => matcher.test(entry.name))) continue;
			const entryPath = path.join(guarded.realPath, entry.name);
			let entryGuarded: GuardedPath;
			try {
				entryGuarded = await this.pathGuard.resolvePath({
					path: entryPath,
					includeHidden: params.includeHidden === true,
				});
			} catch {
				continue;
			}
			try {
				const stat = await this.toFileStat(entryGuarded);
				totalAfterIgnore += 1;
				if (result.length < limit) result.push(stat);
			} catch {
				continue;
			}
		}

		return {
			root: guarded.root,
			path: guarded.realPath,
			entries: result,
			truncated: totalAfterIgnore > result.length,
			totalAfterIgnore,
		};
	}

	async readText(params: FileReadTextParams): Promise<FileReadTextResult> {
		const guarded = await this.resolveRequiredPath(params.path);
		const stats = await stat(guarded.realPath);
		if (!stats.isFile()) {
			throwFileRemoteError({
				code: "FS_NOT_A_FILE",
				message: "Path is not a file.",
				path: guarded.absolutePath,
			});
		}

		const maxBytes = clampLimit(
			params.maxBytes,
			this.limits.maxReadBytes,
			this.limits.maxReadBytes,
		);
		if (await isLikelyBinaryFile(guarded.realPath)) {
			throwFileRemoteError({
				code: "FS_BINARY_FILE",
				message: "Binary files cannot be read as text.",
				path: guarded.absolutePath,
			});
		}

		const bytesToRead = Math.min(stats.size, maxBytes);
		const handle = await open(guarded.realPath, "r");
		try {
			const buffer = Buffer.alloc(bytesToRead);
			const result = await handle.read(buffer, 0, bytesToRead, 0);
			return {
				path: guarded.realPath,
				text: buffer.subarray(0, result.bytesRead).toString("utf8"),
				size: stats.size,
				truncated: stats.size > bytesToRead,
			};
		} finally {
			await handle.close();
		}
	}

	async search(params: FileSearchParams): Promise<FileSearchResult> {
		const query = params.query?.trim();
		if (!query) {
			throwFileRemoteError({
				code: "FS_REQUEST_FAILED",
				message: "Search query must be a non-empty string.",
			});
		}
		const limit = clampLimit(
			params.limit,
			this.limits.maxSearchMatches,
			this.limits.maxSearchMatches,
		);
		const guarded = await this.pathGuard.resolvePath({
			path: params.path,
			rootId: params.rootId,
			includeHidden: params.includeHidden === true,
		});
		const matches: FileSearchMatch[] = [];
		await this.searchPath(guarded.root, guarded.realPath, query, matches, {
			limit,
			includeHidden: params.includeHidden === true,
		});
		return { query, matches };
	}

	async writeText(params: FileWriteTextParams): Promise<FileWriteTextResult> {
		if (!this.writesEnabled) {
			throwFileRemoteError({
				code: "FS_WRITE_DISABLED",
				message: "File writes are disabled. Set ELIZA_FS_ENABLE_WRITES=1 to enable.",
				path: params.path,
			});
		}
		if (typeof params.text !== "string") {
			throwFileRemoteError({
				code: "FS_REQUEST_FAILED",
				message: "Text must be a string.",
				path: params.path,
			});
		}
		const bytes = Buffer.byteLength(params.text, "utf8");
		if (bytes > this.limits.maxWriteBytes) {
			throwFileRemoteError({
				code: "FS_FILE_TOO_LARGE",
				message: "Text exceeds the configured write limit.",
				path: params.path,
				details: { bytes, maxWriteBytes: this.limits.maxWriteBytes },
			});
		}

		const guarded = await this.pathGuard.resolvePath({
			path: params.path,
			allowMissing: true,
		});
		if (guarded.exists && params.overwrite !== true) {
			throwFileRemoteError({
				code: "FS_PATH_DENIED",
				message: "File already exists and overwrite was not enabled.",
				path: guarded.absolutePath,
			});
		}
		if (params.createDirectories === true) {
			await mkdir(path.dirname(guarded.realPath), { recursive: true });
		}
		await writeFile(guarded.realPath, params.text, "utf8");
		return { path: guarded.realPath, bytesWritten: bytes };
	}

	private async resolveRequiredPath(pathValue: string): Promise<GuardedPath> {
		if (typeof pathValue !== "string" || pathValue.trim().length === 0) {
			throwFileRemoteError({
				code: "FS_REQUEST_FAILED",
				message: "Path must be a non-empty string.",
			});
		}
		return this.pathGuard.resolvePath({ path: pathValue });
	}

	private async toFileStat(guarded: GuardedPath): Promise<FileStat> {
		const linkStats = await lstat(guarded.absolutePath);
		const stats = await stat(guarded.realPath);
		const kind = linkStats.isSymbolicLink()
			? "symlink"
			: stats.isFile()
				? "file"
				: stats.isDirectory()
					? "directory"
					: "other";
		return {
			path: guarded.absolutePath,
			name: path.basename(guarded.absolutePath),
			kind,
			size: linkStats.size,
			modifiedAt: stats.mtime.toISOString(),
			...(stats.isFile()
				? { isText: !(await isLikelyBinaryFile(guarded.realPath)) }
				: {}),
		};
	}

	private async searchPath(
		root: FileRoot,
		realPath: string,
		query: string,
		matches: FileSearchMatch[],
		options: { limit: number; includeHidden: boolean },
	): Promise<void> {
		if (matches.length >= options.limit) return;
		let guarded: GuardedPath;
		try {
			guarded = await this.pathGuard.resolvePath({
				path: realPath,
				includeHidden: options.includeHidden,
			});
		} catch {
			return;
		}

		let stats;
		try {
			const linkStats = await lstat(guarded.absolutePath);
			if (linkStats.isSymbolicLink()) return;
			stats = await stat(guarded.realPath);
		} catch {
			return;
		}

		if (stats.isDirectory()) {
			const entries = await readdir(guarded.realPath, { withFileTypes: true });
			for (const entry of entries) {
				if (matches.length >= options.limit) return;
				await this.searchPath(
					root,
					path.join(guarded.realPath, entry.name),
					query,
					matches,
					options,
				);
			}
			return;
		}

		if (!stats.isFile() || stats.size > this.limits.maxSearchFileBytes) return;
		if (await isLikelyBinaryFile(guarded.realPath)) return;

		const text = await readFile(guarded.realPath, "utf8");
		const lowerQuery = query.toLowerCase();
		const lines = text.split(/\r?\n/);
		for (let index = 0; index < lines.length; index += 1) {
			if (matches.length >= options.limit) return;
			const line = lines[index];
			const column = line.toLowerCase().indexOf(lowerQuery);
			if (column === -1) continue;
			matches.push({
				path: guarded.absolutePath,
				line: index + 1,
				column: column + 1,
				preview: line.trim().slice(0, 240),
			});
		}
	}
}

async function isLikelyBinaryFile(filePath: string): Promise<boolean> {
	const handle = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
		const result = await handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0);
		return isLikelyBinaryBuffer(buffer.subarray(0, result.bytesRead));
	} finally {
		await handle.close();
	}
}

function isLikelyBinaryBuffer(buffer: Buffer): boolean {
	if (buffer.length === 0) return false;
	let suspicious = 0;
	for (const byte of buffer) {
		if (byte === 0) return true;
		if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
	}
	return suspicious / buffer.length > 0.1;
}

function globToRegExp(pattern: string): RegExp {
	let regex = "";
	let index = 0;
	while (index < pattern.length) {
		const character = pattern[index];
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				const after = pattern[index + 2];
				if (after === "/") {
					regex += "(?:.*/)?";
					index += 3;
				} else {
					regex += ".*";
					index += 2;
				}
			} else {
				regex += "[^/]*";
				index += 1;
			}
		} else if (character === "?") {
			regex += "[^/]";
			index += 1;
		} else if (character === ".") {
			regex += "\\.";
			index += 1;
		} else if ("+^$()|[]{}\\".includes(character ?? "")) {
			regex += `\\${character}`;
			index += 1;
		} else {
			regex += character;
			index += 1;
		}
	}
	return new RegExp(`^${regex}$`);
}

function clampLimit(
	value: number | undefined,
	defaultValue: number,
	maxValue: number,
): number {
	if (value === undefined) return defaultValue;
	if (!Number.isFinite(value) || value <= 0) return defaultValue;
	return Math.min(Math.floor(value), maxValue);
}
