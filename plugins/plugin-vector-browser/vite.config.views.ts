import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-vector-browser",
  viewId: "vector-browser",
  entry: "./src/VectorBrowserView.tsx",
  outDir: "dist/views",
  componentExport: "VectorBrowserView",
  additionalExternals: ["three"],
});
