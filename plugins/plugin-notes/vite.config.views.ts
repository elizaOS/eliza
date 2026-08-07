/** Builds the Notes dynamic-view bundle. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-notes",
  viewId: "notes",
  entry: "./src/views/notes-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "NotesView",
});
