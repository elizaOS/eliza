import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-lifeops",
  viewId: "lifeops",
  entry: "./src/components/LifeOpsPageView.tsx",
  outDir: "dist/views",
  componentExport: "LifeOpsPageView",
  additionalExternals: [
    "@elizaos/plugin-lifeops",
    "@elizaos/vault",
    "@napi-rs/keyring",
    "@elizaos/plugin-browser",
    "puppeteer-core",
    "puppeteer",
    "jsdom",
  ],
});
