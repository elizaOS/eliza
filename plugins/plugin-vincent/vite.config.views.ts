import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-vincent",
  viewId: "vincent",
  entry: "./src/VincentAppView.tsx",
  outDir: "dist/views",
  componentExport: "VincentAppView",
  additionalExternals: ["@elizaos/app-core"],
});
