/** Builds the focused LifeOps connection-management view bundle. */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-personal-assistant",
  viewId: "lifeops-connections",
  entry:
    "./src/components/lifeops-connections/lifeops-connections-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "LifeOpsConnectionsView",
  additionalExternals: ["@elizaos/app-core"],
});
