/** Builds the /maps dynamic-view bundle. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-maps",
  viewId: "maps",
  entry: "./src/views/maps-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "MapsView",
});
