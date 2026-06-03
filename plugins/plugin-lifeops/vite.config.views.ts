import { fileURLToPath } from "node:url";
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default {
  ...createViewBundleConfig({
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
      // Mobile-only native plugin. Resolved at runtime on Capacitor builds;
      // pruned from desktop / snap workspaces, where the view bundle still
      // needs to compile.
      "@elizaos/capacitor-mobile-signals",
    ],
  }),
  resolve: {
    alias: {
      "@elizaos/plugin-health/screen-time/mobile-signal-setup": fileURLToPath(
        new URL(
          "../plugin-health/src/screen-time/mobile-signal-setup.ts",
          import.meta.url,
        ),
      ),
    },
  },
};
