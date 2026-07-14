/**
 * Executes the real plugin build and proves the emitted runtime is
 * relocatable: build.ts runs assertRelocatableRuntimeOutput over every dist
 * artifact, so a successful import here is the end-to-end proof that no
 * bundle, sourcemap, or declaration map embeds the build machine's absolute
 * checkout path. Bun-native (build.ts drives Bun.build and Bun's $ shell);
 * the plugin's Vitest include globs deliberately do not pick this file up.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("./", import.meta.url));
const checkoutRoot = fileURLToPath(new URL("../../", import.meta.url));

function distFiles(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? distFiles(join(dir, entry.name))
			: [join(dir, entry.name)],
	);
}

describe("plugin-local-inference build relocation audit", () => {
	it("builds a dist tree that embeds no absolute source checkout path", async () => {
		// build.ts resolves entrypoints relative to the working directory.
		const previousCwd = process.cwd();
		process.chdir(pluginRoot);
		try {
			await import("./build.ts");
		} finally {
			process.chdir(previousCwd);
		}

		const files = distFiles(join(pluginRoot, "dist"));
		expect(files.length).toBeGreaterThan(0);
		const leaked = files.filter((file) =>
			readFileSync(file).includes(Buffer.from(checkoutRoot)),
		);
		expect(leaked).toEqual([]);

		// The smoke-imported entrypoints the audit protects must actually exist.
		for (const bundle of [
			"index.js",
			"local-inference-routes.js",
			"voice-wake.js",
			"voice-workbench.js",
		]) {
			expect(statSync(join(pluginRoot, "dist", bundle)).size).toBeGreaterThan(
				0,
			);
		}
		// Real Bun.build + tsc declaration emit; well beyond the default 5s.
	}, 180_000);
});
