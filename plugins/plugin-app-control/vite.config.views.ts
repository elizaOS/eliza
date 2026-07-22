/**
 * Vite config for building plugin-app-control view bundles.
 *
 * Run: `bunx vite build --config vite.config.views.ts`
 * Or:  `bun run build:views --filter plugin-app-control` from the repo root.
 *
 * Emits: `dist/views/bundle.js` — a single ES-module exporting
 * `ViewManagerView` as its named export (and `default`).
 */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
	packageName: "@elizaos/plugin-app-control",
	viewId: "views-manager",
	entry: "./src/views/app-control-view-bundle.ts",
	outDir: "dist/views",
	componentExport: "ViewManagerView",
	additionalExternals: ["@elizaos/core"],
	// The view validates server DTOs fail-closed; stronger compression keeps that
	// boundary safety within the committed 3 kB transport budget.
	minify: "terser",
});
