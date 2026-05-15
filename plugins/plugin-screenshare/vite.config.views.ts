import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-screenshare",
  viewId: "screenshare",
  entry: "./src/ui/ScreenshareOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "ScreenshareOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
