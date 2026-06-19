import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-messages",
  viewId: "messages",
  entry: "./src/components/messages-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "MessagesPluginView",
});
