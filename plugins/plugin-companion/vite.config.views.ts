import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-companion",
  viewId: "companion",
  entry: "./src/components/companion/CompanionView.tsx",
  outDir: "dist/views",
  componentExport: "CompanionView",
  additionalExternals: ["@elizaos/app-core"],
});
