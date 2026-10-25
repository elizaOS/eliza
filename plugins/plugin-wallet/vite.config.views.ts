/** Vite config for the standalone wallet view bundle (`dist/views/bundle.js`), built separately from the Node plugin build. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-wallet",
  viewId: "wallet",
  entry: "./src/ui/wallet-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "InventoryView",
});
