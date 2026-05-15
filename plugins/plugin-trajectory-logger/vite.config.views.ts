import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-trajectory-logger",
  viewId: "trajectory-logger",
  entry: "./src/components/TrajectoryLoggerView.tsx",
  outDir: "dist/views",
  componentExport: "TrajectoryLoggerView",
});
