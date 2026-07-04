/** Vite bundle config for the relationships dashboard view (emits to dist/views). */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-relationships",
  viewId: "relationships",
  entry: "./src/components/relationships/relationships-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "RelationshipsView",
  additionalExternals: ["@elizaos/agent", "@elizaos/app-core"],
});
