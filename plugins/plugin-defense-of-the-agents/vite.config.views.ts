import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-defense-of-the-agents",
  viewId: "defense-of-the-agents",
  entry: "./src/ui/defense-of-the-agents-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "DefenseAgentsOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
