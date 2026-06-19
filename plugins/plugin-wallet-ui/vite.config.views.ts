import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-wallet-ui",
  viewId: "wallet",
  entry: "./src/wallet-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "InventoryView",
});
