/**
 * Vite build configuration for the finances dashboard view bundle.
 */
import path from "node:path";
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-finances",
  viewId: "finances",
  entry: "./src/components/finances/finances-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FinancesView",
  // Bundle the local Plaid link shim because the renderer does not ship it.
  aliases: {
    "react-plaid-link": path.resolve(
      process.cwd(),
      "src/shims/react-plaid-link.ts",
    ),
  },
});
