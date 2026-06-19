import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-waifu-imagegen-app",
  viewId: "waifu-imagegen",
  entry: "./src/imagegen-app-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "ImageGenAppView",
  additionalExternals: ["@elizaos/app-core"],
});
