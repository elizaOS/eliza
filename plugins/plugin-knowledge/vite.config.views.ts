/** Builds the Knowledge app view as a lazy-loaded plugin bundle. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-knowledge",
  viewId: "documents",
  entry: "./src/components/documents/knowledge-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "KnowledgeView",
});
