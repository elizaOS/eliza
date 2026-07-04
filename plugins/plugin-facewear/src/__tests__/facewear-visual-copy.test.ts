/**
 * Visual-copy tests keep the facewear surfaces on shared spatial vocabulary and
 * shell theme tokens instead of bespoke color literals.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

function readSource(relativePath: string): string {
	return readFileSync(resolve(root, relativePath), "utf8");
}

// The collapsed facewear views render through shared spatial and shell tokens.
const FORBIDDEN = ["#0a0a0c", "#6366f1", "#a1a1aa", "rgba("];

describe("facewear visual copy", () => {
	it("keeps the unified Facewear view on the shared spatial vocabulary, not a custom palette", () => {
		for (const file of [
			"components/FacewearView.tsx",
			"components/FacewearSpatialView.tsx",
		]) {
			const source = readSource(file);
			for (const glyph of FORBIDDEN) {
				expect(source, `${file} must not contain "${glyph}"`).not.toContain(
					glyph,
				);
			}
		}
		// Spatial primitives stay in the spatial view, where the shell can theme them.
		expect(
			readSource("components/FacewearSpatialView.tsx"),
			"FacewearSpatialView renders via spatial primitives",
		).toContain("@elizaos/ui/spatial");
	});

	it("does not render redundant helper copy under the Facewear header", () => {
		const source = readSource("components/FacewearView.tsx");

		expect(source).not.toContain(
			"Manage all connected XR devices and smartglasses.",
		);
	});
});
