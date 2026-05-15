import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-task-coordinator",
  viewId: "task-coordinator",
  entry: "./src/CodingAgentTasksPanel.tsx",
  outDir: "dist/views",
  componentExport: "CodingAgentTasksPanel",
});
