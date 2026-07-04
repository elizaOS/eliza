/** Vite config for the `build:views` step: bundles the view entry into dist/views/bundle.js served to the app shell. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-task-coordinator",
  viewId: "task-coordinator",
  entry: "./src/task-coordinator-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "TaskCoordinatorView",
});
