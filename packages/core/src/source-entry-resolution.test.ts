/**
 * Verifies the published source condition through a real Node/tsx package
 * import and audits every platform barrel's relative module targets. The
 * subprocess resolves the workspace package export instead of a test alias.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const sourceRoot = resolve(packageRoot, "src");

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
				"tsx",
				"--input-type=module",
				"--eval",
				probe,
			],
			{ cwd: repositoryRoot, timeout: 30_000 },
		);

		expect(stdout).toContain("core-source-ok");
	});
});
