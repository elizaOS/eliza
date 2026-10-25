import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-elizacloud",
  viewId: "cloud",
  entry: "./src/components/cloud/cloud-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "CloudView",
});
