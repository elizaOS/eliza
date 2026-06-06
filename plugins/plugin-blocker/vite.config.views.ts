import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-blocker",
  viewId: "focus",
  entry: "./src/components/focus/focus-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FocusView",
});
