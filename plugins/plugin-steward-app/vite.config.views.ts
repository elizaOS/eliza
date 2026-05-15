import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-steward",
  viewId: "steward",
  entry: "./src/StewardView.tsx",
  outDir: "dist/views",
  componentExport: "StewardView",
  additionalExternals: ["@elizaos/app-core"],
});
