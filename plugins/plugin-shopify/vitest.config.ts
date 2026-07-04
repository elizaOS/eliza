/**
 * Vitest config for the Shopify plugin: sets the package root and the
 * `@elizaos/*` workspace aliases the tests resolve against.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

export default defineConfig({
  root: here,
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
      {
        find: /^react$/,
        replacement: path.dirname(require.resolve("react/package.json")),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: require.resolve("react/jsx-runtime"),
      },
      {
        find: /^react-dom$/,
        replacement: path.dirname(require.resolve("react-dom/package.json")),
      },
      {
        find: /^react-dom\/client$/,
        replacement: require.resolve("react-dom/client"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
