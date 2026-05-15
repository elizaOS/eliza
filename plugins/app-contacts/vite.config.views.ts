import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-contacts",
  viewId: "contacts",
  entry: "./src/components/ContactsAppView.tsx",
  outDir: "dist/views",
  componentExport: "ContactsAppView",
});
