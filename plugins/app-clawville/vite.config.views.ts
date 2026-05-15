import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-clawville",
  viewId: "clawville",
  entry: "./src/ui/ClawvilleOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "ClawvilleOperatorSurface",
});
