import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-vincent",
  viewId: "vincent",
  entry: "./src/vincent-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "VincentAppView",
  additionalExternals: ["@elizaos/app-core"],
});
