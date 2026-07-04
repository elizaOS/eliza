/** Vite config for the `training` view bundle, delegating to the shared view-bundle builder. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-training",
  viewId: "training",
  entry: "./src/ui/training-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FineTuningView",
});
