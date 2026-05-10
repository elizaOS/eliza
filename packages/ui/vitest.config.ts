import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = fileURLToPath(new URL("./", import.meta.url));
const monorepoRoot = resolve(packageRoot, "../..");
const sharedSrc = resolve(monorepoRoot, "packages/shared/src");
const coreSrc = resolve(monorepoRoot, "packages/core/src");
const reactPath = realpathSync(resolve(packageRoot, "node_modules/react"));
const reactDomPath = realpathSync(
  resolve(packageRoot, "node_modules/react-dom"),
);

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@elizaos\/shared$/,
        replacement: resolve(sharedSrc, "index.ts"),
      },
      {
        find: /^@elizaos\/shared\/(.+)$/,
        replacement: resolve(sharedSrc, "$1"),
      },
      {
        find: /^@elizaos\/core$/,
        replacement: resolve(coreSrc, "index.node.ts"),
      },
      {
        find: /^@elizaos\/core\/(.+)$/,
        replacement: resolve(coreSrc, "$1"),
      },
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
      {
        find: /^discord\.js$/,
        replacement: resolve(packageRoot, "test/stubs/discord-js.ts"),
      },
      {
        find: /^node-llama-cpp$/,
        replacement: resolve(packageRoot, "test/stubs/node-llama-cpp.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    environmentOptions: {
      // jsdom 29 throws `SecurityError: localStorage is not available for
      // opaque origins` unless a concrete url is configured. Tests that
      // declare `// @vitest-environment jsdom` need this to access
      // window.localStorage / window.sessionStorage.
      jsdom: { url: "http://localhost/" },
    },
    server: {
      deps: {
        inline: [
          /^react(?:\/.*)?$/,
          /^react-dom(?:\/.*)?$/,
          /@testing-library\/react/,
        ],
      },
    },
    include: [
      "__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    exclude: [
      "dist/**",
      "**/node_modules/**",
      "**/*.live.test.{ts,tsx}",
      "**/*.real.test.{ts,tsx}",
      "**/*.integration.test.{ts,tsx}",
      "**/*.e2e.test.{ts,tsx}",
      "**/*.e2e.spec.{ts,tsx}",
      "**/*.spec.{ts,tsx}",
    ],
  },
});
