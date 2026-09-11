/** Verifies workspace package discovery against isolated and live layouts. */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	getElizaCoreEntry,
	getInstalledPackageRoot,
} from "./eliza-package-paths.ts";

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

describe("worktree package isolation", () => {
	it.each(["agent", "app-core", "shared"])(
		"loads %s from the requested worktree when a sibling checkout exists",
		async (name) => {
			const root = await mkdtemp(
				path.join(os.tmpdir(), "eliza-worktree-paths-"),
			);
			temporaryRoots.push(root);
			const worktree = path.join(root, "deployment-recovery");
			const current = path.join(worktree, "packages", name);
			const sibling = path.join(
				root,
				"eliza",
				name === "agent" ? "agent" : `packages/${name}`,
			);
			for (const [directory, value] of [
				[current, "current revision"],
				[sibling, "stale revision"],
			] as const) {
				await mkdir(directory, { recursive: true });
				await writeFile(
					path.join(directory, "package.json"),
					JSON.stringify({ name: `@elizaos/${name}` }),
				);
				await writeFile(
					path.join(directory, "entry.mjs"),
					`export default ${JSON.stringify(value)};`,
				);
			}
			const resolved = getInstalledPackageRoot(`@elizaos/${name}`, worktree);
			if (!resolved) throw new Error("Workspace package was not resolved");
			const loaded = await import(
				pathToFileURL(path.join(resolved, "entry.mjs")).href
			);
			expect(loaded.default).toBe("current revision");
		},
	);
});
