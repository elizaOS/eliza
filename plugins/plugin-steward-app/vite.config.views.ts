import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-steward-app",
  viewId: "steward",
  entry: "./src/steward-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "StewardView",
  additionalExternals: ["@elizaos/app-core"],
});
