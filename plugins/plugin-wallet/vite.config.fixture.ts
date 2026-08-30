/** Local browser-QA harness for the Wallet view. Not part of the shipped bundle. */
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(pluginRoot, "../..");
const uiSrc = path.resolve(repoRoot, "packages/ui/src");
const sharedSrc = path.resolve(repoRoot, "packages/shared/src");
const coreSrc = path.resolve(repoRoot, "packages/core/src");
const loggerSrc = path.resolve(repoRoot, "packages/logger/src/index.ts");
const fastRedactShim = path.resolve(
  repoRoot,
  "packages/ui/stories/src/fast-redact-browser-shim.ts",
);
const uiStub = (file: string) =>
  path.resolve(repoRoot, "packages/ui/test/stubs", file);
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
      {
        find: /^@elizaos\/shared$/,
        replacement: path.resolve(sharedSrc, "index.ts"),
      },
      { find: /^@elizaos\/shared\/(.+)$/, replacement: `${sharedSrc}/$1` },
      {
        find: /^@elizaos\/core(?:\/browser)?$/,
        replacement: path.resolve(coreSrc, "index.browser.ts"),
      },
      { find: /^@elizaos\/core\/(.+)$/, replacement: `${coreSrc}/$1` },
      { find: /^@elizaos\/logger$/, replacement: loggerSrc },
      { find: /^fast-redact$/, replacement: fastRedactShim },
      { find: /^node:fs\/promises$/, replacement: uiStub("node-fs.ts") },
      { find: /^node:fs$/, replacement: uiStub("node-fs.ts") },
      { find: /^node:os$/, replacement: uiStub("node-os.ts") },
      { find: /^node:path$/, replacement: uiStub("node-path.ts") },
      { find: /^node:crypto$/, replacement: uiStub("node-crypto.ts") },
      { find: /^node:buffer$/, replacement: uiStub("node-buffer.ts") },
      { find: /^node:url$/, replacement: uiStub("node-url.ts") },
      { find: /^node:events$/, replacement: uiStub("node-events.ts") },
      { find: /^node:util$/, replacement: uiStub("node-util.ts") },
      { find: /^node:module$/, replacement: uiStub("node-module.ts") },
      { find: /^node:stream$/, replacement: uiStub("node-stream.ts") },
      { find: /^node:http$/, replacement: uiStub("node-http.ts") },
      { find: /^node:https$/, replacement: uiStub("node-https.ts") },
      { find: /^node:net$/, replacement: uiStub("node-net.ts") },
      {
        find: /^node:dns\/promises$/,
        replacement: uiStub("node-dns-promises.ts"),
      },
      {
        find: /^node:child_process$/,
        replacement: uiStub("node-child_process.ts"),
      },
      { find: /^fs-extra$/, replacement: uiStub("fs-extra.ts") },
    ],
  },
  server: {
    host: "127.0.0.1",
    port: 2194,
    strictPort: true,
  },
});
