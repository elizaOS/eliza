/**
 * Manifest contract tests for the collapsed views-manager declaration.
 *
 * One manifest entry draws the shipped GUI surface from ViewManagerView while
 * the shared viewType/modality contracts remain available in core.
 */

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

describe("views-manager manifest", () => {
	const views = viewsArray(indexSource);

	it("declares the views-manager view exactly once", () => {
		const ids = [...views.matchAll(/id:\s*"views-manager"/g)];
		expect(ids).toHaveLength(1);
	});

	it("uses a single GUI modality literal", () => {
		expect(views).toContain('modalities: ["gui"]');
		// No `viewType:` escape hatch — the duplicate-per-surface form is gone.
		expect(views).not.toContain("viewType:");
	});

	it("points the single declaration at the ViewManagerView componentExport", () => {
		const exports = [...views.matchAll(/componentExport:\s*"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect(exports).toEqual(["ViewManagerView"]);
	});

	it("keeps the view manager capability ids on the single declaration", () => {
		expect(views).toContain("open-view");
		expect(views).toContain("list-views");
	});

	it("keeps transport state thin and delegates rendering to ViewManagerSpatialView", () => {
		// The shell owns SpatialSurface so plugin views share one host wrapper;
		// this component owns only transport, navigation, and reload state.
		expect(viewSource).not.toContain("<SpatialSurface");
		expect(viewSource).toContain("ViewManagerSpatialView");
		expect(viewSource).toContain("fetchViewEntries");
		expect(viewSource).toContain("requestViewNavigation");
		expect(viewSource).toContain("dispatchNavigateViewEvent");
		// No hardcoded terminal-chrome colors leak back into the wrapper.
		expect(viewSource).not.toContain("#7dd3fc");
		expect(viewSource).not.toContain("#6c63ff");
		expect(viewSource).not.toContain("rgba(");
	});
});
