// Manifest + source-shape contract for the collapsed views-manager declaration.
//
// The catalog ("the views view") collapsed its three gui/xr/tui declarations to
// ONE entry that draws every surface from the single ViewManagerView source
// (modalities ["gui","xr","tui"], componentExport "ViewManagerView"); the
// terminal surface renders ViewManagerSpatialView via the spatial registry.
//
// This pins: exactly one views-manager declaration, the collapsed `modalities`
// literal, no `viewType` (the duplicate-per-surface escape hatch is gone), the
// componentExport, and that ViewManagerView.tsx keeps inheriting shell theme
// tokens rather than the old hardcoded cyan terminal chrome.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

const indexSource = readFileSync(resolve(here, "../index.ts"), "utf8");
const viewSource = readFileSync(resolve(here, "ViewManagerView.tsx"), "utf8");

/** Slice the `views: [ ... ]` array literal out of the plugin manifest source. */
function viewsArray(source: string): string {
	const viewsStart = source.indexOf("views:");
	const arrayStart = source.indexOf("[", viewsStart);
	let depth = 0;
	for (let i = arrayStart; i < source.length; i += 1) {
		if (source[i] === "[") depth += 1;
		if (source[i] === "]") depth -= 1;
		if (depth === 0) return source.slice(arrayStart, i + 1);
	}
	throw new Error("unterminated views array");
}

describe("views-manager manifest (collapsed tri-modal declaration)", () => {
	const views = viewsArray(indexSource);

	it("declares the views-manager view exactly once", () => {
		const ids = [...views.matchAll(/id:\s*"views-manager"/g)];
		expect(ids).toHaveLength(1);
	});

	it("uses a single modalities literal of gui/xr/tui (no per-surface viewType)", () => {
		expect(views).toContain('modalities: ["gui", "xr", "tui"]');
		// No `viewType:` escape hatch — the duplicate-per-surface form is gone.
		expect(views).not.toContain("viewType:");
		// The retired terminal-styled DOM variant is no longer referenced.
		expect(views).not.toContain("ViewManagerTuiView");
	});

	it("points the single declaration at the ViewManagerView componentExport", () => {
		const exports = [...views.matchAll(/componentExport:\s*"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(exports).toEqual(["ViewManagerView"]);
	});

	it("keeps the TUI capability ids on the single declaration", () => {
		expect(views).toContain("terminal-open-view");
		expect(views).toContain("terminal-list-views");
	});

	it("inherits shell theme tokens instead of hardcoded cyan terminal chrome", () => {
		expect(viewSource).toContain("viewManagerTheme");
		expect(viewSource).toContain("var(--background");
		expect(viewSource).toContain("var(--accent");
		expect(viewSource).not.toContain('background: "#0f0f1a"');
		expect(viewSource).not.toContain('background: "#020617"');
		expect(viewSource).not.toContain("#7dd3fc");
		expect(viewSource).not.toContain("#6c63ff");
		expect(viewSource).not.toContain("rgba(");
	});
});
