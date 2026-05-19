import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-shopify-ui",
  viewId: "shopify",
  entry: "./src/ShopifyAppView.tsx",
  outDir: "dist/views",
  componentExport: "ShopifyAppView",
  additionalExternals: ["@elizaos/app-core"],
});
