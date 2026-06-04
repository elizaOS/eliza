import { fileURLToPath } from "node:url";
import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default {
  ...createViewBundleConfig({
    packageName: "@elizaos/plugin-lifeops",
    viewId: "lifeops",
    entry: "./src/components/lifeops-view-bundle.ts",
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
      // plugin-calendar's UI is consumed by LifeOps calendar/overview view
      // sections. Resolve it from source so the view bundle does not depend on
      // plugin-calendar being built first (its dist/ui.js is absent during the
      // root build:views step in CI).
      "@elizaos/plugin-calendar/ui": fileURLToPath(
        new URL("../plugin-calendar/src/ui.ts", import.meta.url),
      ),
    },
  },
};
