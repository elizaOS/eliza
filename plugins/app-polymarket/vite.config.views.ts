import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-polymarket",
  viewId: "polymarket",
  entry: "./src/PolymarketAppView.tsx",
  outDir: "dist/views",
  componentExport: "PolymarketAppView",
  additionalExternals: ["@elizaos/app-core"],
});
