/**
 * Exercises the native-filesystem compatibility layer against the fs-extra
 * behavior relied on by core's personality and plugin-management services.
 */

import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	copy,
	ensureDir,
	ensureSymlink,
	pathExists,
	readJson,
	remove,
	writeJson,
} from "./fs-extra-lite.ts";

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "eliza-fs-extra-lite-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("fs-extra-lite JSON helpers", () => {
	it("reads BOM-prefixed JSON and writes indented JSON with a final newline", async () => {
		const directory = await createTemporaryDirectory();
		const input = path.join(directory, "input.json");
		const output = path.join(directory, "output.json");
		await writeFile(input, '\uFEFF{"enabled":true}', "utf8");

		await expect(readJson<{ enabled: boolean }>(input)).resolves.toEqual({
			enabled: true,
		});
		await writeJson(output, { enabled: true }, { spaces: 2 });

		await expect(readFile(output, "utf8")).resolves.toBe(
			'{\n  "enabled": true\n}\n',
		);
	});

	it("rejects values JSON.stringify cannot serialize", async () => {
		const directory = await createTemporaryDirectory();
		const output = path.join(directory, "output.json");

		await expect(writeJson(output, undefined)).rejects.toThrow(TypeError);
		await expect(pathExists(output)).resolves.toBe(false);
	});
});

describe("fs-extra-lite filesystem helpers", () => {
	it("creates, copies, links, and recursively removes paths", async () => {
		const directory = await createTemporaryDirectory();
		const sourceDirectory = path.join(directory, "source");
		const sourceFile = path.join(sourceDirectory, "value.txt");
		const copiedFile = path.join(directory, "nested", "copied.txt");
		const linkPath = path.join(directory, "links", "value.txt");

		await ensureDir(sourceDirectory);
		await writeFile(sourceFile, "value", "utf8");
		await copy(sourceFile, copiedFile);
		await ensureSymlink(sourceFile, linkPath, "file");

		await expect(pathExists(copiedFile)).resolves.toBe(true);
		await expect(readFile(copiedFile, "utf8")).resolves.toBe("value");
		await expect(readlink(linkPath)).resolves.toBe(sourceFile);

		await remove(sourceDirectory);
		await expect(pathExists(sourceDirectory)).resolves.toBe(false);
	});
});
