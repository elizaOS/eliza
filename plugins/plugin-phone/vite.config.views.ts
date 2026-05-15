import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-phone",
  viewId: "phone",
  entry: "./src/components/PhoneAppView.tsx",
  outDir: "dist/views",
  componentExport: "PhoneAppView",
});
