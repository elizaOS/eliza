/**
 * View bundle configuration for the facewear settings panel served by the app
 * plugin host.
 */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-facewear",
  viewId: "facewear",
  entry: "./src/ui/facewear-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FacewearView",
});
