import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-birdclaw",
  viewId: "birdclaw",
  entry: "./src/components/birdclaw/birdclaw-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "BirdclawView",
});
