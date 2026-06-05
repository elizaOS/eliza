import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-model-tester",
  viewId: "model-tester",
  entry: "./src/model-tester-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ModelTesterAppView",
});
