import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [],
    exclude: ["dist/**", "**/node_modules/**"],
  },
});
