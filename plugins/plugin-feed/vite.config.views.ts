import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-feed",
  viewId: "feed",
  entry: "./src/ui/FeedOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "FeedOperatorSurface",
  additionalExternals: ["@elizaos/app-core", "@elizaos/ui"],
});
