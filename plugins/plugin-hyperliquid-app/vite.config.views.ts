import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-hyperliquid",
  viewId: "hyperliquid",
  entry: "./src/HyperliquidAppView.tsx",
  outDir: "dist/views",
  componentExport: "HyperliquidAppView",
  additionalExternals: ["@elizaos/app-core"],
});
