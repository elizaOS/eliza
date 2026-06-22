import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-waifu-swap-app",
  viewId: "waifu-swap",
  entry: "./src/swap-app-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "SwapView",
  additionalExternals: ["@elizaos/app-core"],
});
