/**
 * Vitest config for app-model-tester: pins a single react/react-dom copy from the
 * workspace UI package (the plugin declares neither directly) and aliases a
 * statically-imported plugin-health subpath to source for the keyless test lane.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// app-model-tester does not declare `react` / `react-dom` directly; resolve them
// from the workspace UI package (which does) so the bare `react` import in
// model-tester-app.ts and the jsdom view tests load at test time without a
// per-package dependency.
const requireFromUi = createRequire(
  path.resolve(__dirname, "../../packages/ui/package.json"),
);
const reactEntry = requireFromUi.resolve("react");
const reactJsxRuntime = requireFromUi.resolve("react/jsx-runtime");
const reactDomEntry = requireFromUi.resolve("react-dom");
const reactDomClient = requireFromUi.resolve("react-dom/client");
const reactDomServer = requireFromUi.resolve("react-dom/server");

export default defineConfig({
  resolve: {
    // Pin a single react/react-dom copy (the UI package's) so a server-render
    // import (react-dom/server, used by the spatial tri-modal view test) cannot
    // resolve a different react-dom version and trip "invalid hook call".
    dedupe: ["react", "react-dom"],
    alias: [
      {
        // @elizaos/ui DynamicViewLoader statically imports this plugin-health
        // subpath; anchor it to source (no built plugin-health dist in the
        // keyless lane). Self-contained so it needs no config-local path vars.
        find: /^@elizaos\/plugin-health\/screen-time\/mobile-signal-setup$/,
        replacement: new URL(
          "../plugin-health/src/screen-time/mobile-signal-setup.ts",
          import.meta.url,
        ).pathname,
      },
      { find: /^react$/, replacement: reactEntry },
      { find: /^react\/jsx-runtime$/, replacement: reactJsxRuntime },
      { find: /^react-dom$/, replacement: reactDomEntry },
      { find: /^react-dom\/client$/, replacement: reactDomClient },
      { find: /^react-dom\/server$/, replacement: reactDomServer },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
