/** Verifies workspace package discovery against isolated on-disk layouts. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getElizaCoreEntry } from "./eliza-package-paths";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) =>
			rm(root, {
				recursive: true,
				force: true,
			}),
		),
	);
});

describe("getElizaCoreEntry", () => {
	it("prefers live source when the supplied root is the elizaOS monorepo", async () => {
		const repoRoot = await mkdtemp(path.join(os.tmpdir(), "eliza-core-paths-"));
		temporaryRoots.push(repoRoot);
		const coreRoot = path.join(repoRoot, "packages", "core");
		const sourceEntry = path.join(coreRoot, "src", "index.node.ts");

		await mkdir(path.dirname(sourceEntry), { recursive: true });
		await mkdir(path.join(coreRoot, "node_modules"), { recursive: true });
		await writeFile(path.join(repoRoot, "package.json"), '{"private":true}\n');
		await writeFile(
			path.join(coreRoot, "package.json"),
			'{"name":"@elizaos/core"}\n',
		);
		await writeFile(sourceEntry, "export {};\n");

		expect(getElizaCoreEntry(repoRoot)).toBe(sourceEntry);
	});
});
