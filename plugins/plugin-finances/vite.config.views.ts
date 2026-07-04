import path from "node:path";
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-finances",
  viewId: "finances",
  entry: "./src/components/finances/finances-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "FinancesView",
  // The finances plugin owns the Plaid link flow; bundle its own stub for the
  // (renderer-unshipped) react-plaid-link widget instead of leaving it external.
  aliases: {
    "react-plaid-link": path.resolve(
      process.cwd(),
      "src/shims/react-plaid-link.ts",
    ),
  },
});
