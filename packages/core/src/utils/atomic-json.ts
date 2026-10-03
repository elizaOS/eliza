/**
 * Atomic JSON read/write helpers (node-only).
 *
 * Consolidates the write-tmp + rename pattern duplicated across the agent
 * package for tokens, ledgers, config snapshots, and runtime operations.
 *
 * Defaults:
 *   - mode 0o600 on the written file (secret-grade)
 *   - dir mode 0o700 when the parent has to be created
 *   - JSON 2-space indent, no trailing newline
 *   - tmp filename `${filePath}.tmp-${pid}-${Date.now()}-${sequence}`
 *   - parent directory created with mkdir recursive
 *
 * On failure, the temp file is best-effort removed.
 *
 * Only values whose top-level `JSON.stringify` result is `undefined` are
 * rejected — top-level `undefined`, function, and symbol — with a `TypeError`
 * before any filesystem work (no parent-directory creation, no temp file), so
 * a rejected write leaves an existing target byte-identical. Nested
 * function/symbol properties keep standard `JSON.stringify` semantics (object
 * properties omitted, array entries become `null`); ordinary optional object
 * properties are unaffected.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { logger } from "../logger.js";

export interface WriteJsonAtomicOptions {
	/** File mode for the final file. Default 0o600. */
	mode?: number;
	/** Directory mode if the parent has to be created. Default 0o700. */
	dirMode?: number;
	/** Append a trailing newline. Default false. */
	trailingNewline?: boolean;
	/** `space` arg passed to JSON.stringify. Default 2. */
	indent?: number | string;
	/** Skip mkdir of the parent directory. Default false. */
	skipMkdir?: boolean;
}

interface NormalizedWriteOptions {
	mode: number;
	dirMode: number;
	trailingNewline: boolean;
	indent: number | string;
	skipMkdir: boolean;
}

function normalizeOptions(
	opts: WriteJsonAtomicOptions | undefined,
): NormalizedWriteOptions {
	return {
		mode: opts?.mode ?? 0o600,
		dirMode: opts?.dirMode ?? 0o700,
		trailingNewline: opts?.trailingNewline ?? false,
		indent: opts?.indent ?? 2,
		skipMkdir: opts?.skipMkdir ?? false,
	};
}

let tmpSequenceCounter = 0n;
const asyncWriteTails = new Map<string, Promise<void>>();

function tmpPathFor(filePath: string): string {
	tmpSequenceCounter += 1n;
	return `${filePath}.tmp-${process.pid}-${Date.now()}-${tmpSequenceCounter}`;
}

function serialize(value: unknown, opts: NormalizedWriteOptions): string {
	const body = JSON.stringify(value, null, opts.indent);
	if (body === undefined) {
		throw new TypeError(`Cannot serialize ${typeof value} to JSON`);
	}
	return opts.trailingNewline ? `${body}\n` : body;
}

function assertFilePath(filePath: string): void {
	if (typeof filePath !== "string" || filePath.trim().length === 0) {
		throw new TypeError("filePath must be a non-empty string");
	}
}

async function serializeAsyncWrite<T>(
	filePath: string,
	write: () => Promise<T>,
): Promise<T> {
	const target = path.resolve(filePath);
	const previous = asyncWriteTails.get(target) ?? Promise.resolve();
	const pending = previous.then(write);
	// error-policy:J5 The returned pending promise reports the write failure to
	// its caller; the non-rejecting tail only keeps later same-target writes live.
	const tail = pending.then(
		() => undefined,
		() => undefined,
	);
	asyncWriteTails.set(target, tail);
	try {
		return await pending;
	} finally {
		if (asyncWriteTails.get(target) === tail) asyncWriteTails.delete(target);
	}
}

export async function writeJsonAtomic(
	filePath: string,
	value: unknown,
	opts?: WriteJsonAtomicOptions,
): Promise<void> {
	assertFilePath(filePath);
	const o = normalizeOptions(opts);
	// Serialize before any filesystem work so top-level undefined/function/
	// symbol (the only values JSON.stringify maps to undefined) reject with a
	// descriptive TypeError before mkdir or temp-file creation. Nested
	// function/symbol values keep standard stringify semantics and are not
	// rejected here.
	const body = serialize(value, o);
	await serializeAsyncWrite(filePath, async () => {
		if (!o.skipMkdir) {
			await fsp.mkdir(path.dirname(filePath), {
				recursive: true,
				mode: o.dirMode,
			});
		}
		const tmp = tmpPathFor(filePath);
		try {
			await fsp.writeFile(tmp, body, {
				encoding: "utf-8",
				mode: o.mode,
				flag: "wx",
			});
			await fsp.rename(tmp, filePath);
		} finally {
			try {
				await fsp.rm(tmp, { force: true });
			} catch (error) {
				// error-policy:J6 best-effort teardown — a stranded temporary file is
				// observable but must not mask the original write/rename failure.
				logger.warn(
					{
						file: tmp,
						error: error instanceof Error ? error.message : String(error),
					},
					"[AtomicJson] Failed to remove temporary file",
				);
			}
		}
	});
}

export function writeJsonAtomicSync(
	filePath: string,
	value: unknown,
	opts?: WriteJsonAtomicOptions,
): void {
	assertFilePath(filePath);
	const o = normalizeOptions(opts);
	// Serialize before mkdir for the same fail-fast ordering as the async
	// path: a top-level unserializable value must not create its parent.
	const body = serialize(value, o);
	if (!o.skipMkdir) {
		fs.mkdirSync(path.dirname(filePath), {
			recursive: true,
			mode: o.dirMode,
		});
	}
	const tmp = tmpPathFor(filePath);
	try {
		fs.writeFileSync(tmp, body, {
			encoding: "utf-8",
			mode: o.mode,
			flag: "wx",
		});
		fs.renameSync(tmp, filePath);
	} finally {
		try {
			fs.rmSync(tmp, { force: true });
		} catch (error) {
			// error-policy:J6 best-effort teardown — see the asynchronous path above.
			logger.warn(
				{
					file: tmp,
					error: error instanceof Error ? error.message : String(error),
				},
				"[AtomicJson] Failed to remove temporary file",
			);
		}
	}
}

/**
 * Read and parse JSON. Only a genuinely absent file returns `null`; malformed
 * JSON and filesystem failures surface to the caller.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
	assertFilePath(filePath);
	try {
		const raw = await fsp.readFile(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// error-policy:J4 an absent optional JSON file is an explicit not-found
			// state; parse and other filesystem failures still propagate.
			return null;
		}
		throw error;
	}
}

/**
 * Synchronous read and parse JSON. Only a genuinely absent file returns `null`;
 * malformed JSON and filesystem failures surface to the caller.
 */
export function readJsonFileSync<T>(filePath: string): T | null {
	assertFilePath(filePath);
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		return JSON.parse(raw) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			// error-policy:J4 an absent optional JSON file is an explicit not-found
			// state; parse and other filesystem failures still propagate.
			return null;
		}
		throw error;
	}
}
