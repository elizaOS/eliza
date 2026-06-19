import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-screenshare",
  viewId: "screenshare",
  entry: "./src/ui/screenshare-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ScreenshareOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
