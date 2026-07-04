/** Vite build config for the Model Tester view bundle (dist/views/bundle.js), via the shared view-bundle preset. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-model-tester",
  viewId: "model-tester",
  entry: "./src/model-tester-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ModelTesterView",
});
