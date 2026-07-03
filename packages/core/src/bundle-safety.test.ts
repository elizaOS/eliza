import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { anchorBundleSafety } from "./bundle-safety.ts";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("anchorBundleSafety", () => {
	it("writes the exact __bundle_safety_<name>__ global key with the given values", () => {
		const marker = { id: "seam-marker" };
		anchorBundleSafety("TEST_SEAM_UNIT", [marker]);
		const key = "__bundle_safety_TEST_SEAM_UNIT__";
		const stashed = (globalThis as Record<string, unknown>)[key];
		expect(Array.isArray(stashed)).toBe(true);
		expect(stashed as unknown[]).toEqual([marker]);
		expect((stashed as unknown[])[0]).toBe(marker);
	});

	it("gives each name a distinct global key so sibling barrels never collide", () => {
		anchorBundleSafety("TEST_SEAM_A", ["a"]);
		anchorBundleSafety("TEST_SEAM_B", ["b"]);
		const g = globalThis as Record<string, unknown>;
		expect(g.__bundle_safety_TEST_SEAM_A__).toEqual(["a"]);
		expect(g.__bundle_safety_TEST_SEAM_B__).toEqual(["b"]);
	});
});

describe("feature barrel anchors are centralized (item #12091.34 invariant)", () => {
	// The inline `const __bundle_safety_X__ = [...]; (globalThis as ...).X = X`
	// pattern is retired in favor of the single anchorBundleSafety helper. Guard
	// against any barrel re-introducing the hand-rolled globalThis assignment.
	const featuresDir = path.join(here, "features");

	function walkIndexFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) out.push(...walkIndexFiles(full));
			else if (entry.name === "index.ts") out.push(full);
		}
		return out;
	}

	const indexFiles = walkIndexFiles(featuresDir);

	it("finds the feature barrels", () => {
		expect(indexFiles.length).toBeGreaterThan(10);
	});

	it("no feature barrel hand-rolls the __bundle_safety_ globalThis assignment", () => {
		const offenders = indexFiles.filter((file) =>
			readFileSync(file, "utf8").includes("__bundle_safety_"),
		);
		expect(offenders).toEqual([]);
	});

	it("every anchored barrel imports the shared helper", () => {
		const anchored = indexFiles.filter((file) =>
			readFileSync(file, "utf8").includes("anchorBundleSafety("),
		);
		expect(anchored.length).toBeGreaterThan(10);
		for (const file of anchored) {
			const src = readFileSync(file, "utf8");
			expect(src).toMatch(
				/import\s*\{\s*anchorBundleSafety\s*\}\s*from\s*"[^"]*bundle-safety\.ts"/,
			);
		}
	});
});
