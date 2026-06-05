import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-companion",
  viewId: "companion",
  entry: "./src/components/companion/companion-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "CompanionView",
  additionalExternals: ["@elizaos/app-core"],
});
