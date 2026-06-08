import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-simple-views",
  viewId: "simple-views",
  entry: "./src/simple-views-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "NotesView",
});
