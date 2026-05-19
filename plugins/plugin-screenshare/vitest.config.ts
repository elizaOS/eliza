import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

export default defineConfig({
  root: here,
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.join(repoRoot, "node_modules/react"),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: path.join(repoRoot, "node_modules/react/jsx-runtime.js"),
      },
      {
        find: /^react-dom$/,
        replacement: path.join(repoRoot, "node_modules/react-dom"),
      },
      {
        find: /^react-dom\/client$/,
        replacement: path.join(repoRoot, "node_modules/react-dom/client.js"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
