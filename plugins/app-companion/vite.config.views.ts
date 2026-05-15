import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-companion",
  viewId: "companion",
  entry: "./src/components/companion/CompanionView.tsx",
  outDir: "dist/views",
  componentExport: "CompanionView",
  additionalExternals: ["@elizaos/app-core"],
});
