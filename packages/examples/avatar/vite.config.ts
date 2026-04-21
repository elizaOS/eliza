import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// `vite.config.ts` lives at `examples/vrm/` → go up 2 levels to the repo root.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const threeRoot = path.join(repoRoot, "node_modules", "three");
const threeEntry = path.join(threeRoot, "build", "three.module.js");
const threeExamplesJsm = path.join(threeRoot, "examples", "jsm");

export default defineConfig({
  plugins: [react()],
  // IMPORTANT: Three.js must be a singleton. In this monorepo we can end up with multiple
  // installed versions (e.g. one nested under another package), which breaks @pixiv/three-vrm.
  resolve: {
    alias: [
      // Keep subpath imports working (e.g. `three/examples/jsm/...`)
      { find: /^three\/examples\/jsm\//, replacement: `${threeExamplesJsm}/` },
      // Force bare `three` to resolve to a single copy/entry.
      { find: /^three$/, replacement: threeEntry },
    ],
    dedupe: ["three"],
  },
  optimizeDeps: {
    include: ["three", "@pixiv/three-vrm"],
  },
  server: {
    port: 5174,
    strictPort: false,
  },
});

