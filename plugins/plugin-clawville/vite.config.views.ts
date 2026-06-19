import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-clawville",
  viewId: "clawville",
  entry: "./src/ui/clawville-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ClawvilleOperatorSurface",
});
