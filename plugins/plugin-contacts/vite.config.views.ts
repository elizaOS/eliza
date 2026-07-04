/**
 * Vite config that bundles the contacts dashboard view to `dist/views`,
 * aliasing the native `@elizaos/capacitor-contacts` bridge for the browser build.
 */
import { fileURLToPath } from "node:url";
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default {
  ...createViewBundleConfig({
    packageName: "@elizaos/plugin-contacts",
    viewId: "contacts",
    entry: "./src/components/contacts-view-bundle.ts",
    outDir: "dist/views",
    componentExport: "ContactsView",
  }),
  resolve: {
    alias: {
      "@elizaos/capacitor-contacts": fileURLToPath(
        new URL(
          "../../plugins/plugin-native-contacts/src/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
};
