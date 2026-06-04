import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-hyperscape",
  viewId: "hyperscape",
  entry: "./src/ui/hyperscape-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "HyperscapeOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
