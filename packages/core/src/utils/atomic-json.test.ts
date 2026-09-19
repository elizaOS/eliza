/**
 * Unit tests for atomic-json read/write helpers in packages/core/src/utils/atomic-json.ts.
 * Exercises async/sync atomic write, async/sync json reading, ENOENT handling, and malformed JSON errors.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readJsonFile,
	readJsonFileSync,
	writeJsonAtomic,
	writeJsonAtomicSync,
} from "./atomic-json";

describe("atomic-json", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "atomic-json-test-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fsp.rm(tempDir, { recursive: true, force: true });
	});

	describe("writeJsonAtomic & readJsonFile (async)", () => {
		it("writes and reads json data atomically", async () => {
			const target = path.join(tempDir, "nested", "data.json");
			const payload = { hello: "world", count: 42, flag: true };

			await writeJsonAtomic(target, payload);
			const readBack = await readJsonFile<typeof payload>(target);

			expect(readBack).toEqual(payload);
		});

		it("returns null for non-existent files (ENOENT)", async () => {
			const missing = path.join(tempDir, "non-existent.json");
			const result = await readJsonFile(missing);
			expect(result).toBeNull();
		});

		it("throws for malformed JSON", async () => {
			const broken = path.join(tempDir, "broken.json");
			await fsp.writeFile(broken, "{ invalid json", "utf-8");

			await expect(readJsonFile(broken)).rejects.toThrow(SyntaxError);
		});

		it("supports custom formatting options like trailingNewline and indent", async () => {
			const target = path.join(tempDir, "formatted.json");
			await writeJsonAtomic(
				target,
				{ a: 1 },
				{ trailingNewline: true, indent: 4 },
			);

			const raw = await fsp.readFile(target, "utf-8");
			expect(raw).toBe('{\n    "a": 1\n}\n');
		});
	});

	describe("writeJsonAtomicSync & readJsonFileSync (sync)", () => {
		it("writes and reads json data synchronously", () => {
			const target = path.join(tempDir, "sync-nested", "data.json");
			const payload = { name: "eliza", items: [1, 2, 3] };

			writeJsonAtomicSync(target, payload);
			const readBack = readJsonFileSync<typeof payload>(target);

			expect(readBack).toEqual(payload);
		});

		it("returns null for non-existent files (ENOENT)", () => {
			const missing = path.join(tempDir, "missing-sync.json");
			const result = readJsonFileSync(missing);
			expect(result).toBeNull();
		});

		it("throws for malformed JSON", () => {
			const broken = path.join(tempDir, "broken-sync.json");
			fs.writeFileSync(broken, "not valid json {", "utf-8");

			expect(() => readJsonFileSync(broken)).toThrow(SyntaxError);
		});

		it("supports custom formatting options synchronously", () => {
			const target = path.join(tempDir, "sync-formatted.json");
			writeJsonAtomicSync(
				target,
				{ b: 2 },
				{ trailingNewline: true, indent: 0 },
			);

			const raw = fs.readFileSync(target, "utf-8");
			expect(raw).toBe('{"b":2}\n');
		});
	});

	describe("concurrency and validation", () => {
		it("handles concurrent same-target writes in the same millisecond", async () => {
			vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
			const target = path.join(tempDir, "concurrent.json");
			const writes = Array.from({ length: 20 }, (_, index) =>
				writeJsonAtomic(target, { index }),
			);

			await Promise.all(writes);

			const readBack = await readJsonFile<{ index: number }>(target);
			expect(readBack?.index).toBeGreaterThanOrEqual(0);
			expect(readBack?.index).toBeLessThan(20);
			expect((await fsp.readdir(tempDir)).sort()).toEqual(["concurrent.json"]);
		});

		it("rejects top-level undefined and preserves a good file", async () => {
			const target = path.join(tempDir, "undefined-value.json");
			// A pre-existing good file must survive the rejected write untouched.
			await fsp.writeFile(target, '{"ok":true}\n', "utf-8");

			await expect(
				writeJsonAtomic(
					target,
					undefined as unknown as Record<string, unknown>,
				),
			).rejects.toThrow(new TypeError("Cannot serialize undefined to JSON"));

			// The trailingNewline variant rejects the same way; default
			// trailingNewline is false (atomic-json.ts normalizeOptions).
			await expect(
				writeJsonAtomic(
					target,
					undefined as unknown as Record<string, unknown>,
					{ trailingNewline: true },
				),
			).rejects.toThrow(new TypeError("Cannot serialize undefined to JSON"));

			expect(await fsp.readFile(target, "utf-8")).toBe('{"ok":true}\n');
			expect(await fsp.readdir(tempDir)).toEqual(["undefined-value.json"]);

			await expect(readJsonFile(target)).resolves.toEqual({ ok: true });
		});

		it("rejects undefined under a nonexistent parent without creating it", async () => {
			const parent = path.join(tempDir, "no-such-parent-async");
			const target = path.join(parent, "data.json");

			await expect(
				writeJsonAtomic(target, undefined as unknown as string),
			).rejects.toThrow(new TypeError("Cannot serialize undefined to JSON"));

			// Serialization happens before mkdir, so the parent must not exist.
			await expect(fsp.access(parent)).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(await fsp.readdir(tempDir)).toEqual([]);
		});

		it("rejects undefined synchronously and preserves a good file", () => {
			const target = path.join(tempDir, "undefined-sync.json");
			fs.writeFileSync(target, '{"ok":true}\n', "utf-8");

			expect(() =>
				writeJsonAtomicSync(
					target,
					undefined as unknown as Record<string, unknown>,
				),
			).toThrow(new TypeError("Cannot serialize undefined to JSON"));

			// Synchronous trailingNewline variant rejects without touching bytes.
			expect(() =>
				writeJsonAtomicSync(
					target,
					undefined as unknown as Record<string, unknown>,
					{ trailingNewline: true },
				),
			).toThrow(new TypeError("Cannot serialize undefined to JSON"));

			expect(fs.readFileSync(target, "utf-8")).toBe('{"ok":true}\n');
			expect(fs.readdirSync(tempDir)).toEqual(["undefined-sync.json"]);
		});

		it("rejects undefined synchronously without creating a missing parent", () => {
			const parent = path.join(tempDir, "no-such-parent-sync");
			const target = path.join(parent, "data.json");

			expect(() =>
				writeJsonAtomicSync(target, undefined as unknown as string),
			).toThrow(new TypeError("Cannot serialize undefined to JSON"));

			expect(() => fs.accessSync(parent)).toThrow();
			expect(fs.readdirSync(tempDir)).toEqual([]);
		});

		it("rejects only top-level function/symbol without creating a parent", async () => {
			const parent = path.join(tempDir, "no-such-parent-fn");
			const fnTarget = path.join(parent, "fn.json");
			const symTarget = path.join(parent, "sym.json");

			await expect(
				writeJsonAtomic(fnTarget, () => "unserializable" as unknown as string),
			).rejects.toThrow(new TypeError("Cannot serialize function to JSON"));
			await expect(
				writeJsonAtomic(symTarget, Symbol("s") as unknown as string),
			).rejects.toThrow(new TypeError("Cannot serialize symbol to JSON"));

			// Neither rejected write may create the missing parent.
			await expect(fsp.access(parent)).rejects.toMatchObject({
				code: "ENOENT",
			});
			expect(await fsp.readdir(tempDir)).toEqual([]);

			// Nested function properties keep JSON semantics (omitted), proving
			// the guard does not broaden to ordinary optional properties.
			const nestedTarget = path.join(tempDir, "nested-fn.json");
			await writeJsonAtomic(nestedTarget, {
				a: 1,
				f: (() => "x") as unknown as string,
			});
			expect(await fsp.readFile(nestedTarget, "utf-8")).toContain('"a": 1');
			expect(await readJsonFile<{ a: number }>(nestedTarget)).toEqual({
				a: 1,
			});
		});

		it("rejects non-string or empty file paths", async () => {
			await expect(
				writeJsonAtomic("" as unknown as string, {}),
			).rejects.toThrow(TypeError);
			await expect(
				writeJsonAtomic(null as unknown as string, {}),
			).rejects.toThrow(TypeError);
			expect(() => writeJsonAtomicSync("" as unknown as string, {})).toThrow(
				TypeError,
			);
			await expect(readJsonFile("" as unknown as string)).rejects.toThrow(
				TypeError,
			);
			expect(() => readJsonFileSync("" as unknown as string)).toThrow(
				TypeError,
			);
		});
	});
});
