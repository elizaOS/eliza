import { fileURLToPath } from "node:url";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const elizaRoot = path.resolve(here, "../../../..");
const plugins = path.join(elizaRoot, "plugins");

const calendarHookStub = path.join(here, "stubs/useCalendarWeek.ts");
const calendarDrawerStub = path.join(here, "stubs/EventEditorDrawer.tsx");

/**
 * The calendar components reference their data hook + event drawer with
 * relative `.js` specifiers (`../hooks/useCalendarWeek.js`,
 * `./EventEditorDrawer.js`). A `resolve.alias` `find` matches the import
 * specifier string, which won't catch those relative paths reliably. Intercept
 * by basename in a `resolveId` hook instead — these basenames are unique to the
 * calendar plugin, so redirecting them to inert stubs keeps CalendarSection
 * offline (its only network seams) without touching any other module.
 */
function calendarSeamStubPlugin() {
  return {
    name: "view-harness-calendar-seam-stub",
    enforce: "pre",
    resolveId(source) {
      if (source.endsWith("/hooks/useCalendarWeek.js")) {
        return calendarHookStub;
      }
      if (source.endsWith("/EventEditorDrawer.js")) {
        return calendarDrawerStub;
      }
      return null;
    },
  };
}

export default defineConfig({
  root: here,
  // Self-contained: do not load packages/app/postcss/tailwind/etc.
  css: { postcss: {} },
  plugins: [calendarSeamStubPlugin(), react()],
  resolve: {
    // De-dupe React so the views and the harness share one copy.
    dedupe: ["react", "react-dom"],
    alias: [
      // Subpath must come before the bare package alias.
      {
        find: "@elizaos/ui/agent-surface",
        replacement: path.join(here, "stubs/elizaos-ui-agent-surface.ts"),
      },
      {
        find: "@elizaos/ui",
        replacement: path.join(here, "stubs/elizaos-ui.tsx"),
      },
    ],
  },
  build: {
    outDir: path.join(here, "dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
  },
  // @elizaos/shared (calendar type import) is type-only; no runtime resolution
  // needed. Keep optimizeDeps from trying to crawl the workspace.
  optimizeDeps: { entries: [path.join(here, "entry.tsx")] },
});
