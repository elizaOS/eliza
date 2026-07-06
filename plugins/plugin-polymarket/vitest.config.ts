/**
 * Vitest config for this plugin's unit/component tests. Aliases React/ReactDOM
 * to their real installed copies (avoiding duplicate-instance dedup issues)
 * and anchors a couple of cross-plugin subpaths to source for the keyless
 * test lane.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const uiSrc = path.join(repoRoot, "packages/ui/src");
const tuiSrc = path.join(repoRoot, "packages/tui/src");
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
      {
        find: /^@elizaos\/app-core$/,
        replacement: path.resolve(here, "__tests__/app-core-shim.ts"),
      },
      {
        find: /^@elizaos\/app-core\/(.+)$/,
        replacement: path.resolve(here, "../../packages/app-core/src/$1.ts"),
      },
      {
        find: /^@elizaos\/ui\/agent-surface$/,
        replacement: path.join(uiSrc, "agent-surface/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/spatial$/,
        replacement: path.join(uiSrc, "spatial/index.ts"),
      },
      {
        find: /^@elizaos\/ui\/spatial\/tui$/,
        replacement: path.join(uiSrc, "spatial/tui/index.ts"),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.join(tuiSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/ui\/spatial\/tui$/,
        replacement: path.resolve(
          here,
          "../../packages/ui/src/spatial/tui/index.ts",
        ),
      },
      {
        find: /^@elizaos\/ui\/spatial$/,
        replacement: path.resolve(
          here,
          "../../packages/ui/src/spatial/index.ts",
        ),
      },
      {
        find: /^@elizaos\/tui$/,
        replacement: path.resolve(here, "../../packages/tui/src/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
