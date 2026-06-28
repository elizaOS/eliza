import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-shopify",
  viewId: "shopify",
  entry: "./src/shopify-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ShopifyView",
  additionalExternals: ["@elizaos/app-core"],
});
