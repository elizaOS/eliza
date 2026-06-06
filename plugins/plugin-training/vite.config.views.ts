import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-training",
  viewId: "training",
  entry: "./src/ui/training-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FineTuningView",
});
