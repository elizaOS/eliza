/** Vite config for the runtime view bundle (dist/views/bundle.js): bundles the messages-view-bundle entry so the plugin view loader can mount the `MessagesView` export. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-messages",
  viewId: "messages",
  entry: "./src/components/messages-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "MessagesView",
});
