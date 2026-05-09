import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const reactPath = realpathSync(resolve(packageRoot, "node_modules/react"));
const reactDomPath = realpathSync(resolve(packageRoot, "node_modules/react-dom"));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: resolve(reactPath, "index.js"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolve(reactPath, "jsx-runtime.js"),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolve(reactPath, "jsx-dev-runtime.js"),
      },
      {
        find: /^react-dom$/,
        replacement: resolve(reactDomPath, "index.js"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: resolve(reactDomPath, "client.js"),
      },
      {
        find: /^zlib-sync$/,
        replacement: resolve(packageRoot, "test/stubs/zlib-sync.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    server: {
      deps: {
        inline: [/^react(?:\/.*)?$/, /^react-dom(?:\/.*)?$/, /@testing-library\/react/],
      },
    },
    include: [
      "__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
