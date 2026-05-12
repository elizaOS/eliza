import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import baseConfig from "../../test/vitest/default.config";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  ...baseConfig,
  root: here,
  test: {
    ...baseConfig.test,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "__tests__/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
