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
	buildEdgeOnly,
	buildNodeOnly,
	CANONICAL_ERRORS_RUNTIME_EXPORTS,
	emitFlatEntrypoints,
	planFlatEntrypoints,
	validateFlatEntrypoints,
} from "../build";
import * as errorsModule from "./errors";

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
	it("keeps the canonical build shim aligned with errors.ts runtime exports", () => {
		expect(Object.keys(errorsModule).sort()).toEqual(
			[...CANONICAL_ERRORS_RUNTIME_EXPORTS].sort(),
		);
	});

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
		const entrypointSets: string[][] = [];
		const pluginNames: string[][] = [];
		const declarationOptions: Array<{ skipTesting?: boolean } | undefined> = [];

		await buildNodeOnly({
			argv: ["bun", "build.ts", "--node-only", "--skip-testing"],
			runnerFactory: (options) => {
				outdirs.push(options.buildOptions.outdir ?? "dist");
				entrypointSets.push(options.buildOptions.entrypoints ?? []);
				pluginNames.push(
					(options.buildOptions.plugins ?? []).map((plugin) => plugin.name),
				);
				return async () => {};
			},
			generateDeclarations: async (options) => {
				declarationOptions.push(options);
			},
		});

		expect(outdirs).toEqual(["dist/node", "dist/node"]);
		expect(entrypointSets[0]).toEqual(["src/errors.ts"]);
		expect(entrypointSets[1]).not.toContain("src/errors.ts");
		expect(pluginNames[0]).toEqual([]);
		expect(pluginNames[1]).toContain("eliza-core-canonical-errors");
		expect(declarationOptions).toEqual([{ skipTesting: true }]);
	});

	it("emits the shared errors artifact before an Edge-only root", async () => {
		const builds: Array<{
			entrypoints: string[];
			outdir: string;
			plugins: string[];
		}> = [];
		let edgeWrites = 0;

		await buildEdgeOnly({
			runnerFactory: (options) => {
				builds.push({
					entrypoints: options.buildOptions.entrypoints ?? [],
					outdir: options.buildOptions.outdir ?? "dist",
					plugins: (options.buildOptions.plugins ?? []).map(
						(plugin) => plugin.name,
					),
				});
				return async () => {};
			},
			edgeBundleIo: {
				readFile: async () => "",
				writeFile: async () => {
					edgeWrites += 1;
				},
			},
		});

		expect(builds).toEqual([
			{
				entrypoints: ["src/errors.ts"],
				outdir: "dist/node",
				plugins: [],
			},
			{
				entrypoints: ["src/index.edge.ts"],
				outdir: "dist/edge",
				plugins: ["eliza-core-canonical-errors", "eliza-core-workerd-sources"],
			},
		]);
		expect(edgeWrites).toBe(1);
	});
});
