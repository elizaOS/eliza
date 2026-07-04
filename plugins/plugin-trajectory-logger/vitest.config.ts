/** Vitest config for the trajectory-logger plugin: aliases React and testing-library to the workspace UI package's copies so the peer-dep-only components and jsdom render tests resolve without a per-package dependency. */
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "vitest/config";

// plugin-trajectory-logger declares react/react-dom only as peer deps; resolve
// them (and @testing-library/react) from the workspace UI package, which depends
// on them directly, so the bare `react` import in the view components and the
// jsdom render tests load at test time without a per-package dependency.
// Mirrors plugins/app-model-tester/vitest.config.ts.
const requireFromUi = createRequire(
  path.resolve(__dirname, "../../packages/ui/package.json"),
);
const reactEntry = requireFromUi.resolve("react");
const reactJsxRuntime = requireFromUi.resolve("react/jsx-runtime");
const reactDomEntry = requireFromUi.resolve("react-dom");
const reactDomClient = requireFromUi.resolve("react-dom/client");

export default defineConfig({
  resolve: {
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
    ],
  },
  test: {
    include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
