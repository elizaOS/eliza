import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-feed",
  viewId: "feed",
  entry: "./src/ui/feed-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FeedView",
});
