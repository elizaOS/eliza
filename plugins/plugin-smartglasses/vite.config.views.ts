import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-smartglasses",
  viewId: "smartglasses",
  entry: "./src/ui/SmartglassesView.tsx",
  outDir: "dist/views",
  componentExport: "SmartglassesView",
});
