import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-messages",
  viewId: "messages",
  entry: "./src/components/MessagesAppView.tsx",
  outDir: "dist/views",
  componentExport: "MessagesAppView",
});
