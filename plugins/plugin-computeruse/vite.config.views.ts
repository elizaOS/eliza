/** Builds the computer-use session monitor as a host-loadable plugin view. */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-computeruse",
  viewId: "computer-use-sessions",
  entry: "./src/views/computer-use-sessions-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ComputerUseSessionsView",
  additionalExternals: ["@elizaos/app-core"],
});
