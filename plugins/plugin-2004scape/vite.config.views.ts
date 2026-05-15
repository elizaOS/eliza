import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-2004scape",
  viewId: "2004scape",
  entry: "./src/ui/TwoThousandFourScapeOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "TwoThousandFourScapeOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
