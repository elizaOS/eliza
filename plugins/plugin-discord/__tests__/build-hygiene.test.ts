import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sharedTestRoot = resolve(packageRoot, "../../packages/test");
const tscPackage = createRequire(import.meta.url).resolve(
	"typescript/package.json",
);
const tsc = resolve(dirname(tscPackage), "bin/tsc");

describe("plugin-discord declaration build", () => {
	it("keeps test configuration outside the declaration graph", () => {
		const buildConfig = JSON.parse(
			readFileSync(resolve(packageRoot, "tsconfig.build.json"), "utf8"),
		);
		expect(buildConfig.exclude).toEqual(
			expect.arrayContaining(["vitest.config.ts", "vitest.harness.config.ts"]),
		);

		const result = spawnSync(
			process.execPath,
			[tsc, "--project", "tsconfig.build.json", "--noCheck", "--listFilesOnly"],
			{
				cwd: packageRoot,
				encoding: "utf8",
			},
		);
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

		const declarationGraph = result.stdout.split(/\r?\n/u).filter(Boolean);
		expect(declarationGraph).not.toContain(
			resolve(packageRoot, "vitest.config.ts"),
		);
		expect(declarationGraph).not.toContain(
			resolve(packageRoot, "vitest.harness.config.ts"),
		);
		expect(
			declarationGraph.some((file) => file.startsWith(`${sharedTestRoot}/`)),
		).toBe(false);
	});
});
