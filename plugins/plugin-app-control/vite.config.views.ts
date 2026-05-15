/**
 * Vite config for building plugin-app-control view bundles.
 *
 * Run: `bunx vite build --config vite.config.views.ts`
 * Or:  `bun run build:views --filter plugin-app-control` from the repo root.
 *
 * Emits: `dist/views/bundle.js` — a single ES-module exporting
 * `ViewManagerView` as its named export (and `default`).
 */

import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
	packageName: "@elizaos/plugin-app-control",
	viewId: "views-manager",
	entry: "./src/views/ViewManagerView.tsx",
	outDir: "dist/views",
	componentExport: "ViewManagerView",
});
