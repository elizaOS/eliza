import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-scape",
  viewId: "scape",
  entry: "./src/ui/scape-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ScapeOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
