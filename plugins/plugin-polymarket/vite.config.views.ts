import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-polymarket",
  viewId: "polymarket",
  entry: "./src/polymarket-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "PolymarketView",
  additionalExternals: ["@elizaos/app-core"],
});
