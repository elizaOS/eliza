import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-model-tester",
  viewId: "model-tester",
  entry: "./src/ModelTesterAppView.tsx",
  outDir: "dist/views",
  componentExport: "ModelTesterAppView",
});
