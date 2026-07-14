/**
 * Verifies the real npm tarball inventory keeps runtime source exports while
 * excluding development-only tests from the published plugin.
 */

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface PackedFile {
	path: string;
}

interface PackResult {
	files: PackedFile[];
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectRuntimeSources(directory: string): string[] {
	const sources: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== "__tests__") {
				sources.push(...collectRuntimeSources(absolutePath));
			}
			continue;
		}
		if (
			entry.isFile() &&
			entry.name !== ".npmignore" &&
			!entry.name.includes(".test.") &&
			!entry.name.includes(".spec.")
		) {
			sources.push(relative(packageRoot, absolutePath));
		}
	}
	return sources;
}

describe("published package inventory", () => {
	it(
		"ships runtime sources and compiled output without test harnesses",
		() => {
			const output = execFileSync(
				"npm",
				["pack", "--dry-run", "--json", "--ignore-scripts"],
				{
					cwd: packageRoot,
					encoding: "utf8",
				},
			);
			const [result] = JSON.parse(output) as PackResult[];
			if (!result) {
				throw new Error("npm pack did not return an inventory");
			}

			const packedPaths = new Set(result.files.map((file) => file.path));
			for (const sourcePath of collectRuntimeSources(join(packageRoot, "src"))) {
				expect(packedPaths.has(sourcePath), `${sourcePath} is missing`).toBe(true);
			}

			expect(packedPaths.has("dist/index.js")).toBe(true);
			expect(packedPaths.has("registry-entry.json")).toBe(true);
			expect(
				[...packedPaths].filter(
					(filePath) =>
						filePath.includes("/__tests__/") ||
						/\.(?:test|spec)\.[^/]+$/.test(filePath),
				),
			).toEqual([]);
		},
		60_000,
	);
});
