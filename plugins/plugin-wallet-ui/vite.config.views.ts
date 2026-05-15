import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-wallet-ui",
  viewId: "wallet",
  entry: "./src/InventoryView.tsx",
  outDir: "dist/views",
  componentExport: "InventoryView",
});
