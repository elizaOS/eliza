import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-task-coordinator",
  viewId: "task-coordinator",
  entry: "./src/CodingAgentTasksPanel.tsx",
  outDir: "dist/views",
  componentExport: "CodingAgentTasksPanel",
});
