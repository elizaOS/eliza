/**
 * Verifies the deterministic package-export planner and build orchestration
 * against nested conditions, deleted artifacts, and node-only skip behavior.
 * The harness uses temporary files and injected build runners; it does not run
 * a compiler or import generated product code.
 */
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
	buildNodeOnly,
	emitFlatEntrypoints,
	planFlatEntrypoints,
	validateFlatEntrypoints,
} from "../build";

const temporaryRoots: string[] = [];

async function makeTemporaryRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "eliza-core-flat-entrypoints-"));
	temporaryRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
	);
});

describe("core flat package entrypoints", () => {
	it("recursively selects runtime fallbacks and computes nested specifiers", () => {
		const plans = planFlatEntrypoints({
			"./package.json": "./package.json",
			"./node": {
				default: "./dist/node/index.node.js",
			},
			"./recursive": {
				types: "./dist/recursive.d.ts",
				browser: {
					import: "./dist/browser/recursive.js",
				},
				default: [
					{
						custom: {
							import: "./dist/node/deep/recursive.js",
						},
					},
				],
			},
			"./security/kms": {
				node: {
					import: "./dist/node/security/kms/index.js",
				},
			},
			"./services/*": "./dist/services/*.js",
		});

		expect(plans).toEqual([
			{
				exportPath: "./recursive",
				flatFile: "dist/recursive.js",
				targetFile: "dist/node/deep/recursive.js",
				moduleSpecifier: "./node/deep/recursive.js",
			},
			{
				exportPath: "./security/kms",
				flatFile: "dist/security/kms.js",
				targetFile: "dist/node/security/kms/index.js",
				moduleSpecifier: "../node/security/kms/index.js",
			},
		]);
	});

	it("fails validation when a generated flat artifact is deleted", async () => {
		const rootDir = await makeTemporaryRoot();
		const exportsMap = {
			"./client-public": {
				browser: "./dist/browser/client-public.js",
				default: "./dist/node/client-public.js",
			},
			"./security/kms": {
				default: "./dist/node/security/kms/index.js",
			},
		};
		for (const target of [
			"dist/node/client-public.js",
			"dist/node/security/kms/index.js",
		]) {
			const absoluteTarget = join(rootDir, target);
			await mkdir(dirname(absoluteTarget), { recursive: true });
			await writeFile(absoluteTarget, "export const ok = true;\n", "utf8");
		}

		const plans = await emitFlatEntrypoints(exportsMap, { rootDir });
		await validateFlatEntrypoints(plans, { rootDir });
		expect(
			await readFile(join(rootDir, "dist/security/kms.js"), "utf8"),
		).toContain('export * from "../node/security/kms/index.js";');

		await unlink(join(rootDir, "dist/security/kms.js"));
		await expect(validateFlatEntrypoints(plans, { rootDir })).rejects.toThrow(
			"./security/kms: dist/security/kms.js",
		);
	});

	it("does not build or validate the testing target with --skip-testing", async () => {
		const outdirs: string[] = [];
		const declarationOptions: Array<{ skipTesting?: boolean } | undefined> = [];

		await buildNodeOnly({
			argv: ["bun", "build.ts", "--node-only", "--skip-testing"],
			runnerFactory: (options) => {
				outdirs.push(options.buildOptions.outdir ?? "dist");
				return async () => {};
			},
			generateDeclarations: async (options) => {
				declarationOptions.push(options);
			},
		});

		expect(outdirs).toEqual(["dist/node"]);
		expect(declarationOptions).toEqual([{ skipTesting: true }]);
	});
});
