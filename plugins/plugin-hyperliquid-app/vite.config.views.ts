import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-hyperliquid-app",
  viewId: "hyperliquid",
  entry: "./src/hyperliquid-app-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "HyperliquidAppView",
  additionalExternals: ["@elizaos/app-core"],
});
