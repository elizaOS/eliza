/**
 * Vite config that bundles the contacts dashboard view to `dist/views`,
 * consuming the published native bridge through its package boundary.
 */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default {
  ...createViewBundleConfig({
    packageName: "@elizaos/plugin-contacts",
    viewId: "contacts",
    entry: "./src/components/contacts-view-bundle.ts",
    outDir: "dist/views",
    componentExport: "ContactsView",
  }),
};
