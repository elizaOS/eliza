import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-trajectory-logger",
  viewId: "trajectory-logger",
  entry: "./src/components/TrajectoryLoggerView.tsx",
  outDir: "dist/views",
  componentExport: "TrajectoryLoggerView",
});
