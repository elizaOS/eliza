import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-polymarket-app",
  viewId: "polymarket",
  entry: "./src/polymarket-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "PolymarketAppView",
  additionalExternals: ["@elizaos/app-core"],
});
