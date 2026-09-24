/**
 * Vite config for the standalone story gallery app (aliases, shims, dev server).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { defineConfig, type Plugin } from "vite";
import { rejectRuntimeInRendererPlugin } from "../../app/scripts/lib/renderer-runtime-boundary.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const uiSrc = path.resolve(here, "../src");
const brandAssets = path.resolve(here, "../assets");
const cleanupHelper = path.resolve(
  repoRoot,
  "packages/scripts/rm-path-recursive.mjs",
);
// Brand components (ElizaLogo, lockups, …) reference assets under `/brand/*`
// (BRAND_PATHS in @elizaos/ui/brand → packages/ui/assets). Serve those
// from the UI assets in dev and copy them into dist on build so the
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
        const file = path.join(brandAssets, url.slice("/brand/".length));
        if (!file.startsWith(brandAssets) || !fs.existsSync(file))
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
      fs.cpSync(brandAssets, dest, { recursive: true });
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
  // Tailwind v4 generates the utility classes from the `@source` globs in
  // src/styles/styles.css (which already point at packages/ui/src). Without this
  // the catalog/lab rendered every component with its inline styles only —
  // positioning utilities like `fixed`/`absolute` silently no-op'd, so the
  // floating chat overlay flowed statically instead of anchoring to the frame.
  plugins: [
    rejectRuntimeInRendererPlugin(),
    tailwindcss(),
    react(),
    brandAssetsPlugin(),
  ],
  resolve: {
    alias: [
      { find: "@ui-src", replacement: uiSrc },
      // Resolve @elizaos/ui from THIS package's source (not its built dist) so
      // the registered-views page and the plugin register modules share ONE
      // spatial renderer instance — the source one that captures view thunks
      // (`getSpatialViewThunk`). With a dist resolution they'd hit two different
      // renderer modules and the thunk registry would come up empty.
      { find: /^@elizaos\/ui$/, replacement: path.resolve(uiSrc, "index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: `${uiSrc}/$1` },
    ],
  },
  server: {
    port: 4321,
  },
});
