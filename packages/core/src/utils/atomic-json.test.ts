/**
 * Unit tests for atomic-json read/write helpers in packages/core/src/utils/atomic-json.ts.
 * Exercises async/sync atomic write, async/sync json reading, ENOENT handling, and malformed JSON errors.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
		it("handles multiple concurrent writes to separate files without collision", async () => {
			const writes = Array.from({ length: 20 }, (_, i) => {
				const file = path.join(tempDir, `concurrent-${i}.json`);
				return writeJsonAtomic(file, { index: i, timestamp: Date.now() });
			});

			await Promise.all(writes);

			for (let i = 0; i < 20; i++) {
				const readBack = await readJsonFile<{ index: number }>(
					path.join(tempDir, `concurrent-${i}.json`),
				);
				expect(readBack?.index).toBe(i);
			}
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
