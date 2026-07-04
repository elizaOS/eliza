/** Vite build for the `inbox` view overlay bundle (`dist/views/bundle.js`), the artifact the view registration's `bundlePath` points to. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-inbox",
  viewId: "inbox",
  entry: "./src/components/inbox/inbox-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "InboxView",
  additionalExternals: ["@elizaos/app-core"],
});
