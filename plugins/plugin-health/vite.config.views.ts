/**
 * Vite build configuration for the health view bundle consumed by app hosts.
 */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-health",
  viewId: "health",
  entry: "./src/components/health/health-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "HealthView",
});
