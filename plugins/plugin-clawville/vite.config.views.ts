import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-clawville",
  viewId: "clawville",
  entry: "./src/ui/ClawvilleOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "ClawvilleOperatorSurface",
});
