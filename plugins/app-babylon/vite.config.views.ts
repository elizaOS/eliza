import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-babylon",
  viewId: "babylon",
  entry: "./src/ui/BabylonOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "BabylonOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
