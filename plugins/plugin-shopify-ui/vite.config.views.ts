import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-shopify-ui",
  viewId: "shopify",
  entry: "./src/shopify-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ShopifyAppView",
  additionalExternals: ["@elizaos/app-core"],
});
