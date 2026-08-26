import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-documents",
  viewId: "documents",
  entry: "./src/components/documents/knowledge-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "KnowledgeView",
});
