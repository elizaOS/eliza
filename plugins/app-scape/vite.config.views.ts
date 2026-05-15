import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-scape",
  viewId: "scape",
  entry: "./src/ui/ScapeOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "ScapeOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
