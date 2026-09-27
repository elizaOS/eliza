import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.{test,spec}.ts", "src/**/*.{test,spec}.ts"],
  },
});
