/** Vite config for the `dist/views/bundle.js` view build (`build:views`), driven by the shared view-bundle preset. */
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-polymarket",
  viewId: "polymarket",
  entry: "./src/polymarket-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "PolymarketView",
  additionalExternals: ["@elizaos/app-core"],
});
