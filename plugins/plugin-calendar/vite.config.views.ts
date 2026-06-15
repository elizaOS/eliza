import { createViewBundleConfig } from "../../packages/scripts/view-bundle-vite.config.ts";

export default createViewBundleConfig({
  packageName: "@elizaos/plugin-calendar",
  viewId: "calendar",
  entry: "./src/components/calendar/calendar-view-bundle.ts",
  outDir: "dist/views",
  componentExport: "CalendarView",
  additionalExternals: ["@elizaos/app-core"],
});
