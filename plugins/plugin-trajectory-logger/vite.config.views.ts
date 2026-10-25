/** Vite config that builds the standalone view bundle (dist/views/bundle.js) from the view-bundle entry, exposing `TrajectoryLoggerView` for the overlay view loader. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-trajectory-logger",
  viewId: "trajectory-logger",
  entry: "./src/components/trajectory-logger-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "TrajectoryLoggerView",
});
