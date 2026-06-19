import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-finances",
  viewId: "finances",
  entry: "./src/components/finances/finances-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FinancesView",
});
