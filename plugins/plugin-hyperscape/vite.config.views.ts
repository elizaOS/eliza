import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-hyperscape",
  viewId: "hyperscape",
  entry: "./src/ui/HyperscapeOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "HyperscapeOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
