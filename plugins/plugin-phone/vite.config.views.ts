/** Vite config for the `phone` plugin view bundle (dist/views/bundle.js) loaded by the elizaOS view registry. */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-phone",
  viewId: "phone",
  entry: "./src/components/phone-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "PhoneView",
});
