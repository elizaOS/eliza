/** Verifies workspace package discovery against isolated and live layouts. */

import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { getElizaCoreEntry, getUiSourceRoot } from "./eliza-package-paths.ts";

const temporaryRoots: string[] = [];
const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

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
		const isolatedRepoRoot = await mkdtemp(
			path.join(os.tmpdir(), "eliza-core-paths-"),
		);
		temporaryRoots.push(isolatedRepoRoot);
		const coreRoot = path.join(isolatedRepoRoot, "packages", "core");
		const sourceEntry = path.join(coreRoot, "src", "index.node.ts");

		await mkdir(path.dirname(sourceEntry), { recursive: true });
		await mkdir(path.join(coreRoot, "node_modules"), { recursive: true });
		await writeFile(
			path.join(isolatedRepoRoot, "package.json"),
			'{"private":true}\n',
		);
		await writeFile(
			path.join(coreRoot, "package.json"),
			'{"name":"@elizaos/core"}\n',
		);
		await writeFile(sourceEntry, "export {};\n");

		expect(getElizaCoreEntry(isolatedRepoRoot)).toBe(sourceEntry);
	});
});

describe("workspace package source discovery", () => {
	it("resolves @elizaos/ui to packages/ui/src", () => {
		expect(realpathSync(getUiSourceRoot(repoRoot) ?? "")).toBe(
			realpathSync(path.join(repoRoot, "packages/ui/src")),
		);
	});
});
