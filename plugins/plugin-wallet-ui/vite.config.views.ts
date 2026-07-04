/** Vite config for the standalone wallet view bundle (`dist/views/bundle.js`), built separately from the tsup plugin-entry build. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-wallet-ui",
  viewId: "wallet",
  entry: "./src/wallet-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "InventoryView",
});
