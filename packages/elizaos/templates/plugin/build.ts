#!/usr/bin/env bun
/**
 * Build script for a scaffolded plugin package: cleans dist, compiles the
 * runtime and frontend bundles, and copies package metadata for publishing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const RM_RECURSIVE_SCRIPT = fileURLToPath(
	new URL("./scripts/rm-path-recursive.mjs", import.meta.url),
);

function rmRecursive(target: string) {
	const result = spawnSync(process.execPath, [RM_RECURSIVE_SCRIPT, target], {
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`rm-path-recursive failed for ${target} with status ${result.status}`,
		);
	}
}

async function cleanBuild(outdir = "dist") {
	if (existsSync(outdir)) {
		rmRecursive(outdir);
		console.log(`✓ Cleaned ${outdir} directory`);
	}
}

async function build() {
	const start = performance.now();
	console.log("🚀 Building plugin...");

	try {
		await cleanBuild("dist");

		const [buildResult] = await Promise.all([
			(async () => {
				console.log("📦 Bundling with Bun...");
				const result = await Bun.build({
					entrypoints: ["./src/index.ts"],
					outdir: "./dist",
					target: "node",
					format: "esm",
					sourcemap: true,
					minify: false,
					external: ["dotenv", "node:*", "@elizaos/core", "zod"],
					naming: {
						entry: "[dir]/[name].[ext]",
					},
				});

				if (!result.success) {
					console.error("✗ Build failed:", result.logs);
					return { success: false, outputs: [] };
				}

				const totalSize = result.outputs.reduce(
					(sum, output) => sum + output.size,
					0,
				);
				const sizeMB = (totalSize / 1024 / 1024).toFixed(2);
				console.log(`✓ Built ${result.outputs.length} file(s) - ${sizeMB}MB`);

				return result;
			})(),

			(async () => {
				console.log("📝 Generating TypeScript declarations...");
				await $`tsc --emitDeclarationOnly --incremental --noCheck --project ./tsconfig.build.json`.quiet();
				console.log("✓ TypeScript declarations generated");
				return { success: true };
			})(),
		]);

		if (!buildResult.success) {
			return false;
		}

		const elapsed = ((performance.now() - start) / 1000).toFixed(2);
		console.log(`✅ Build complete! (${elapsed}s)`);
		return true;
	} catch (error) {
		console.error("Build error:", error);
		return false;
	}
}

build()
	.then((success) => {
		if (!success) {
			process.exit(1);
		}
	})
	.catch((error) => {
		console.error("Build script error:", error);
		process.exit(1);
	});
