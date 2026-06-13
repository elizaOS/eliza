import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-personal-assistant",
  viewId: "lifeops",
  entry: "./src/components/lifeops-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "LifeOpsPageView",
});
