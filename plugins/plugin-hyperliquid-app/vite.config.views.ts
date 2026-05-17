import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-hyperliquid-app",
  viewId: "hyperliquid",
  entry: "./src/HyperliquidAppView.tsx",
  outDir: "dist/views",
  componentExport: "HyperliquidAppView",
  additionalExternals: ["@elizaos/app-core"],
});
