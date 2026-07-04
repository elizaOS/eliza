/** Vite config for the standalone Hyperliquid view bundle (`dist/views/bundle.js`), built from the shared view-bundle preset. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
	packageName: "@elizaos/plugin-hyperliquid",
	viewId: "hyperliquid",
	entry: "./src/hyperliquid-app-view-bundle.ts",
	outDir: "dist/views",
	componentExport: "HyperliquidView",
	additionalExternals: ["@elizaos/app-core"],
});
