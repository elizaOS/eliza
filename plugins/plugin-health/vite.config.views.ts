/** Vite build config for the health view bundle (dist/views/bundle.js). */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-health",
  viewId: "health",
  entry: "./src/components/health/health-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "HealthView",
});
