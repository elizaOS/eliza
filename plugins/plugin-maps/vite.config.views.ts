/** Builds the signed Maps view bundle consumed by the dynamic view loader. */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-maps",
  viewId: "maps",
  entry: "./src/components/maps-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "MapsView",
});
