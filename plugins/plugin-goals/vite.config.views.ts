import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-goals",
  viewId: "goals",
  entry: "./src/components/goals/goals-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "GoalsView",
  additionalExternals: ["@elizaos/agent"],
});
