/** Builds the shared Notes and Simple Calendar dynamic-view bundle. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-simple-views",
  viewId: "simple-views",
  entry: "./src/views/simple-views-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "NotesView",
});
