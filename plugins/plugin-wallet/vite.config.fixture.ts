/** Local browser-QA harness for the Wallet view. Not part of the shipped bundle. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");
const uiSrc = path.resolve(repoRoot, "packages/ui/src");
const uiRequire = createRequire(
  path.resolve(repoRoot, "packages/ui/package.json"),
);
const { default: tailwindcss } = await import(
  uiRequire.resolve("@tailwindcss/vite")
);
const { default: react } = await import(
  uiRequire.resolve("@vitejs/plugin-react-swc")
);

export default defineConfig({
  root: path.resolve(pluginRoot, "src/ui/__e2e__"),
  define: {
    "process.env": "({})",
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      { find: /^@elizaos\/ui$/, replacement: path.resolve(uiSrc, "index.ts") },
      { find: /^@elizaos\/ui\/(.+)$/, replacement: `${uiSrc}/$1` },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 2194,
    strictPort: true,
  },
});
