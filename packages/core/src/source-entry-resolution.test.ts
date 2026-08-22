/**
 * Verifies the published source condition through real Node/tsx and Vite
 * consumers, and audits every platform barrel's relative module targets. The
 * subprocesses resolve package exports instead of test aliases.
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
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

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

describe("core source export resolution", () => {
	it("keeps package conditions on the intended platform entrypoints", async () => {
		const packageJson = JSON.parse(
			await readFile(resolve(packageRoot, "package.json"), "utf8"),
		) as {
			exports: Record<string, Record<string, unknown>>;
		};
		const rootExport = packageJson.exports["."];
		const sourceExport = rootExport["eliza-source"] as Record<string, string>;

		expect(sourceExport.import).toBe("./src/index.ts");
		expect(packageJson.exports["./node"]["eliza-source"]).toMatchObject({
			import: "./src/index.node.ts",
		});
		expect(packageJson.exports["./browser"]["eliza-source"]).toMatchObject({
			import: "./src/index.browser.ts",
		});
		expect(rootExport.node).toMatchObject({
			import: "./dist/node/index.node.js",
		});
		expect(rootExport.browser).toMatchObject({
			import: "./dist/browser/index.browser.js",
		});
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

	it("imports the real package source condition through Node and tsx", async () => {
		const probe = [
			'import("@elizaos/core")',
			'.then((core) => { if (typeof core.ElizaError !== "function") throw new Error("missing ElizaError"); process.stdout.write("core-source-ok\\n"); })',
		].join("");
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"--conditions=eliza-source",
				"--import",
				tsxImport,
				"--input-type=module",
				"--eval",
				probe,
			],
			{ cwd: repositoryRoot, timeout: 30_000 },
		);

		expect(stdout).toContain("core-source-ok");
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
			await execFileAsync(process.execPath, viteArgs, {
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
				execFileAsync(process.execPath, viteArgs, {
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
