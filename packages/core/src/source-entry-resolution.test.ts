/**
 * Verifies source package conditions from isolated consumers that resolve this
 * checkout rather than repository TypeScript aliases.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sourceRoot = resolve(packageRoot, "src");
const viteCli = resolve(repositoryRoot, "node_modules/vite/bin/vite.js");
const tsxImport = import.meta.resolve("tsx");
const platformEntries = [
	"index.ts",
	"index.node.ts",
	"index.browser.ts",
	"index.edge.ts",
] as const;
let consumerRoot = "";

function sourceUrl(relativePath: string): string {
	return pathToFileURL(resolve(packageRoot, relativePath)).href;
}

function consumerPackageUrl(relativePath: string): string {
	return pathToFileURL(
		resolve(consumerRoot, "node_modules/@elizaos/core", relativePath),
	).href;
}

function targetExists(importer: string, specifier: string): boolean {
	const unresolved = resolve(dirname(importer), specifier);
	const hasModuleExtension = /\.(?:[cm]?[jt]sx?|json|node)$/.test(specifier);
	const candidates = hasModuleExtension
		? [unresolved, unresolved.replace(/\.js$/, ".ts")]
		: [
				`${unresolved}.ts`,
				`${unresolved}.tsx`,
				resolve(unresolved, "index.ts"),
			];
	return candidates.some((candidate) => existsSync(candidate));
}

async function runResolutionProbe(
	executable: string,
	loaderArgs: string[],
	conditions: string[],
	expected: Record<string, string>,
	importRoot = false,
): Promise<string> {
	const probe = [
		`const expected = ${JSON.stringify(expected)};`,
		"for (const [specifier, target] of Object.entries(expected)) {",
		"  const actual = import.meta.resolve(specifier);",
		'  if (actual !== target) throw new Error(specifier + " resolved to " + actual + ", expected " + target);',
		"}",
		...(importRoot
			? [
					'const core = await import("@elizaos/core");',
					'const nodeCore = await import("@elizaos/core/node");',
					'if (typeof core.ElizaError !== "function") throw new Error("missing ElizaError");',
					'if (core.ElizaError !== nodeCore.ElizaError) throw new Error("duplicate core runtime instance");',
				]
			: []),
		'process.stdout.write("core-source-ok\\n");',
	].join("\n");
	const { stdout } = await execFileAsync(
		executable,
		[
			...conditions.map((condition) => `--conditions=${condition}`),
			...loaderArgs,
			"--input-type=module",
			"--eval",
			probe,
		],
		{
			cwd: consumerRoot,
			timeout: 30_000,
			env: {
				...process.env,
				TSX_TSCONFIG_PATH: join(consumerRoot, "tsconfig.json"),
			},
		},
	);
	return stdout;
}

describe("core source export resolution", () => {
	beforeAll(async () => {
		consumerRoot = await mkdtemp(join(tmpdir(), "eliza-core-source-consumer-"));
		await mkdir(join(consumerRoot, "node_modules", "@elizaos"), {
			recursive: true,
		});
		await symlink(
			packageRoot,
			join(consumerRoot, "node_modules", "@elizaos", "core"),
			"junction",
		);
		await writeFile(
			join(consumerRoot, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					module: "NodeNext",
					moduleResolution: "NodeNext",
				},
			}),
		);
	});

	afterAll(async () => {
		if (consumerRoot) {
			await rm(consumerRoot, { recursive: true, force: true });
		}
	});

	it("keeps unsupported browser and workerd source paths on built artifacts", async () => {
		const packageJson = JSON.parse(
			await readFile(resolve(packageRoot, "package.json"), "utf8"),
		) as { exports: Record<string, Record<string, unknown>> };
		const sourceExport = packageJson.exports["."]["eliza-source"];

		expect(sourceExport).toMatchObject({
			import: "./src/index.ts",
		});
		expect(packageJson.exports["./browser"]).not.toHaveProperty("eliza-source");
		expect(packageJson.exports["./edge"]).not.toHaveProperty("eliza-source");
		expect(packageJson.exports["./testing"]["eliza-source"]).toMatchObject({
			import: "./src/testing/index.ts",
		});
		for (const [specifier, conditions] of Object.entries(packageJson.exports)) {
			const conditionOrder = Object.keys(conditions);
			const sourceIndex = conditionOrder.indexOf("eliza-source");
			if (sourceIndex < 0) continue;
			for (const platform of ["browser", "workerd"]) {
				const platformIndex = conditionOrder.indexOf(platform);
				if (platformIndex < 0) continue;
				expect(
					platformIndex,
					`${specifier} must prefer ${platform} over eliza-source`,
				).toBeLessThan(sourceIndex);
			}
		}
	});

	it("uses an explicit TypeScript hop at the package source boundary", async () => {
		const source = await readFile(resolve(sourceRoot, "index.ts"), "utf8");
		expect(source).toContain('export * from "./index.node.ts";');
		expect(source).not.toMatch(/from ["']\.\/index\.node["']/);
	});

	it("keeps every platform barrel relative specifier resolvable", async () => {
		const missing: string[] = [];
		for (const entry of platformEntries) {
			const absoluteEntry = resolve(sourceRoot, entry);
			const source = await readFile(absoluteEntry, "utf8");
			const specifiers = source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g);
			for (const match of specifiers) {
				if (!targetExists(absoluteEntry, match[1])) {
					missing.push(`${entry}: ${match[1]}`);
				}
			}
		}
		expect(missing).toEqual([]);
	});

	it("imports the exact Node source package without repository path aliases", async () => {
		const stdout = await runResolutionProbe(
			"node",
			["--import", import.meta.resolve("tsx")],
			["eliza-source"],
			{
				"@elizaos/core": sourceUrl("src/index.ts"),
				"@elizaos/core/node": sourceUrl("src/index.node.ts"),
				"@elizaos/core/browser": consumerPackageUrl(
					"dist/browser/index.browser.js",
				),
				"@elizaos/core/edge": consumerPackageUrl("dist/edge/index.edge.js"),
				"@elizaos/core/testing": sourceUrl("src/testing/index.ts"),
			},
			true,
		);
		expect(stdout).toContain("core-source-ok");
	}, 30_000);

	it("imports the exact Bun source package without a TypeScript loader", async () => {
		const stdout = await runResolutionProbe(
			"bun",
			[],
			["eliza-source"],
			{ "@elizaos/core": sourceUrl("src/index.ts") },
			true,
		);
		expect(stdout).toContain("core-source-ok");
	});

	it("selects verified browser and workerd builds ahead of Node source", async () => {
		await expect(
			runResolutionProbe("node", [], ["eliza-source", "browser"], {
				"@elizaos/core": consumerPackageUrl("dist/browser/index.browser.js"),
			}),
		).resolves.toContain("core-source-ok");
		await expect(
			runResolutionProbe("node", [], ["eliza-source", "workerd"], {
				"@elizaos/core": consumerPackageUrl("dist/edge/index.edge.js"),
			}),
		).resolves.toContain("core-source-ok");
	});

	it("loads the source export through an actual Vite config consumer", async () => {
		const fixtureRoot = await mkdtemp(
			join(tmpdir(), "eliza-core-vite-source-consumer-"),
		);
		try {
			const copiedCoreRoot = join(
				fixtureRoot,
				"node_modules",
				"@elizaos",
				"core",
			);
			await mkdir(copiedCoreRoot, { recursive: true });
			await cp(sourceRoot, join(copiedCoreRoot, "src"), { recursive: true });
			await cp(
				resolve(packageRoot, "package.json"),
				join(copiedCoreRoot, "package.json"),
			);
			await symlink(
				resolve(packageRoot, "node_modules"),
				join(copiedCoreRoot, "node_modules"),
				"dir",
			);

			await expect(
				execFileAsync(
					"node",
					[
						"--conditions=eliza-source",
						"--conditions=browser",
						"--input-type=module",
						"--eval",
						'import("@elizaos/core")',
					],
					{ cwd: fixtureRoot, timeout: 30_000 },
				),
			).rejects.toMatchObject({
				stderr: expect.stringMatching(
					/Cannot find module|ERR_MODULE_NOT_FOUND/u,
				),
			});

			await writeFile(
				join(fixtureRoot, "entry.js"),
				"export const viteSourceConsumer = true;\n",
			);
			await writeFile(
				join(fixtureRoot, "vite.config.mjs"),
				[
					'import { ElizaError } from "@elizaos/core";',
					'if (typeof ElizaError !== "function") throw new Error("Vite did not load the core source export");',
					"export default {",
					'  build: { outDir: "dist", lib: { entry: "entry.js", formats: ["es"], fileName: () => "bundle.js" } },',
					'  logLevel: "error",',
					"};",
					"",
				].join("\n"),
			);

			const viteArgs = [
				"--conditions=eliza-source",
				"--import",
				tsxImport,
				viteCli,
				"build",
				"--configLoader",
				"native",
				"--config",
				"vite.config.mjs",
			];
			await execFileAsync("node", viteArgs, {
				cwd: fixtureRoot,
				timeout: 30_000,
			});
			expect(existsSync(join(fixtureRoot, "dist", "bundle.js"))).toBe(true);

			const copiedEntry = join(copiedCoreRoot, "src", "index.ts");
			const explicitSource = await readFile(copiedEntry, "utf8");
			expect(explicitSource).toContain('export * from "./index.node.ts";');
			await writeFile(
				copiedEntry,
				explicitSource.replace(
					'export * from "./index.node.ts";',
					'export * from "./index.node";',
				),
			);
			await rm(join(fixtureRoot, "dist"), { recursive: true, force: true });

			await expect(
				execFileAsync("node", viteArgs, {
					cwd: fixtureRoot,
					timeout: 30_000,
				}),
			).rejects.toMatchObject({
				stderr: expect.stringMatching(/index\.node|ERR_MODULE_NOT_FOUND/u),
			});
		} finally {
			await rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});
