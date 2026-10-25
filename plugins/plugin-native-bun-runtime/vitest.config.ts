/**
 * Vitest config for this plugin's JS-side unit tests: runs every `.test.ts`
 * file under `src/` in a Node environment, excluding compiled `dist/` output.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
