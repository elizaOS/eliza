/** Vite bundle config for the todos dashboard view (emits to dist/views). */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-todos",
  viewId: "todos",
  entry: "./src/components/todos/todos-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "TodosView",
  additionalExternals: ["@elizaos/app-core"],
});
