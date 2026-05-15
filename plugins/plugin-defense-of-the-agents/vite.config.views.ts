import { createViewBundleConfig } from "../../scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/app-defense-of-the-agents",
  viewId: "defense-of-the-agents",
  entry: "./src/ui/DefenseAgentsOperatorSurface.tsx",
  outDir: "dist/views",
  componentExport: "DefenseAgentsOperatorSurface",
  additionalExternals: ["@elizaos/app-core"],
});
