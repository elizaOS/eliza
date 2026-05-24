import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-facewear",
  viewId: "hearwear",
  entry: "./src/ui/FacewearView.tsx",
  outDir: "dist/views",
  componentExport: "FacewearView",
});
