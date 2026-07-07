/**
 * Vite config for the standalone story gallery app (aliases, shims, dev server).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react-swc";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const uiSrc = path.resolve(here, "../src");
const sharedSrc = path.resolve(here, "../../shared/src");
const sharedAssets = path.resolve(here, "../../shared/assets");
const cleanupHelper = path.resolve(
  repoRoot,
  "packages/scripts/rm-path-recursive.mjs",
);
const coreBrowserShim = path.resolve(here, "src/eliza-core-browser-shim.ts");
const fastRedactShim = path.resolve(here, "src/fast-redact-browser-shim.ts");
const nodeBuiltinsShim = path.resolve(
  here,
  "src/node-builtins-browser-shim.ts",
);
const tuiBrowserShim = path.resolve(here, "src/elizaos-tui-browser-shim.ts");
const loggerSrc = path.resolve(repoRoot, "packages/logger/src/index.ts");

// Brand components (ElizaLogo, lockups, …) reference assets under `/brand/*`
// (BRAND_PATHS in @elizaos/shared/brand → packages/shared/assets). Serve those
// from the shared package in dev and copy them into dist on build so the
// catalog renders logos instead of broken images.
function brandAssetsPlugin(): Plugin {
  const types: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
    ".mp4": "video/mp4",
    ".webmanifest": "application/manifest+json",
  };
  return {
    name: "stories-brand-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?")[0];
        if (!url.startsWith("/brand/")) return next();
        const file = path.join(sharedAssets, url.slice("/brand/".length));
        if (!file.startsWith(sharedAssets) || !fs.existsSync(file))
          return next();
        res.setHeader(
          "Content-Type",
          types[path.extname(file)] ?? "application/octet-stream",
        );
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      const dest = path.resolve(here, "dist/brand");
      execFileSync("node", [cleanupHelper, dest], {
        cwd: repoRoot,
        stdio: "inherit",
      });
      fs.cpSync(sharedAssets, dest, { recursive: true });
    },
  };
}

export default defineConfig({
  root: here,
  // Shared UI source reads Node's `process.env` (terminal/theme, globals, etc.)
  // unguarded at module load; shim it to an empty object so those modules can
  // be imported in the browser catalog.
  define: {
    "process.env": "({})",
  },
  plugins: [react(), brandAssetsPlugin()],
  resolve: {
    alias: [
      { find: "@ui-src", replacement: uiSrc },
      // Resolve @elizaos/ui from THIS package's source (not its built dist) so
      // every stories page and the modules it mounts share ONE spatial renderer
      // instance; with a dist resolution they'd hit two different renderer
      // modules and registry-backed pages would come up empty.
      { find: /^@elizaos\/ui$/, replacement: path.resolve(uiSrc, "index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: `${uiSrc}/$1` },
      { find: "@elizaos/core", replacement: coreBrowserShim },
      { find: "@elizaos/logger", replacement: loggerSrc },
      { find: /^@elizaos\/shared$/, replacement: sharedSrc },
      { find: /^@elizaos\/shared\/(.+)$/, replacement: `${sharedSrc}/$1` },
      // @elizaos/ui/spatial/tui → @elizaos/tui; the full tui entry pulls a
      // node:child_process access that throws in the browser. Shim it to the
      // pure registry + width utils so browser-mounted spatial pages render.
      { find: "@elizaos/tui", replacement: tuiBrowserShim },
      { find: "fast-redact", replacement: fastRedactShim },
      // The shared barrel re-exports a node-only package-root resolver
      // (utils/eliza-root.ts). The catalog never calls it, but its top-level
      // `node:*` imports throw under Vite's dev externalization; alias to browser shims.
      { find: "node:url", replacement: nodeBuiltinsShim },
      { find: "node:fs/promises", replacement: nodeBuiltinsShim },
      { find: "node:fs", replacement: nodeBuiltinsShim },
      { find: "node:path", replacement: nodeBuiltinsShim },
      { find: "node:os", replacement: nodeBuiltinsShim },
    ],
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        {
          name: "elizaos-core-browser-entry",
          setup(build) {
            build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
              path: coreBrowserShim,
            }));
            build.onResolve({ filter: /^@elizaos\/core\/browser$/ }, () => ({
              path: coreBrowserShim,
            }));
            build.onResolve({ filter: /^@elizaos\/logger$/ }, () => ({
              path: loggerSrc,
            }));
            build.onResolve({ filter: /^fast-redact$/ }, () => ({
              path: fastRedactShim,
            }));
          },
        },
      ],
    },
  },
  server: {
    port: 4321,
  },
});
