/** Vite build config for the `lifeops-live-test` view bundle (dist/views/bundle.js). */

import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-scheduling",
  viewId: "lifeops-live-test",
  entry: "./src/components/lifeops-live-test/lifeops-live-test-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "LifeOpsLiveTestView",
});
