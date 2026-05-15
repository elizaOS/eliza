import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-training",
  viewId: "training",
  entry: "./src/ui/FineTuningView.tsx",
  outDir: "dist/views",
  componentExport: "FineTuningView",
});
