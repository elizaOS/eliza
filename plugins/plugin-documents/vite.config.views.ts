import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-documents",
  viewId: "documents",
  entry: "./src/components/documents/documents-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "DocumentsView",
  additionalExternals: ["@elizaos/app-core"],
});
